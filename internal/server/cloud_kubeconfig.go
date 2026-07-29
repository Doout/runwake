package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const maxImportedKubeconfigSize = 4 << 20

type cloudKubeconfigRequest struct {
	Provider string `json:"provider"`
	Command  string `json:"command"`
}

type cloudKubeconfigResponse struct {
	Kubeconfig    string            `json:"kubeconfig"`
	Name          string            `json:"name"`
	ExecAllowlist []string          `json:"exec_allowlist"`
	Environment   map[string]string `json:"environment,omitempty"`
}

type cloudCommandPlan struct {
	executable    string
	args          []string
	name          string
	execAllowlist []string
	environment   map[string]string
	stdoutConfig  bool
}

func (s *Server) handleCloudKubeconfigImport(w http.ResponseWriter, r *http.Request) {
	var request cloudKubeconfigRequest
	if !decodeJSON(w, r, 64<<10, &request) {
		return
	}
	words, err := splitCommandWords(request.Command)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tempDir, err := os.MkdirTemp("", "runwake-cloud-kubeconfig-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create temporary kubeconfig directory: "+err.Error())
		return
	}
	defer func() { _ = os.RemoveAll(tempDir) }()
	kubeconfigPath := filepath.Join(tempDir, "config")
	plan, err := buildCloudCommandPlan(request.Provider, words, kubeconfigPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, lookupErr := exec.LookPath(plan.executable); lookupErr != nil {
		writeError(w, http.StatusBadRequest, plan.executable+" is not installed or is not available to Runwake")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, plan.executable, plan.args...) //nolint:gosec // The provider parser restricts executable and argument shapes.
	command.Env = append(os.Environ(), "KUBECONFIG="+kubeconfigPath)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()
	if ctx.Err() != nil {
		writeError(w, http.StatusGatewayTimeout, "cloud credential command timed out")
		return
	}
	if runErr != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = strings.TrimSpace(stdout.String())
		}
		if len(message) > 4096 {
			message = message[len(message)-4096:]
		}
		if message == "" {
			message = runErr.Error()
		}
		writeError(w, http.StatusBadRequest, fmt.Sprintf("%s could not import cluster credentials: %s", plan.executable, message))
		return
	}
	var kubeconfig []byte
	if plan.stdoutConfig {
		kubeconfig = stdout.Bytes()
	} else {
		kubeconfig, err = os.ReadFile(kubeconfigPath) //nolint:gosec // kubeconfigPath is created inside the private temporary directory above.
		if err != nil {
			writeError(w, http.StatusBadRequest, "cloud command completed without producing a kubeconfig")
			return
		}
	}
	if len(kubeconfig) == 0 {
		writeError(w, http.StatusBadRequest, "cloud command produced an empty kubeconfig")
		return
	}
	if len(kubeconfig) > maxImportedKubeconfigSize {
		writeError(w, http.StatusBadRequest, "generated kubeconfig is larger than 4 MiB")
		return
	}
	writeJSON(w, http.StatusOK, cloudKubeconfigResponse{
		Kubeconfig: string(kubeconfig), Name: plan.name, ExecAllowlist: plan.execAllowlist, Environment: plan.environment,
	})
}

func buildCloudCommandPlan(provider string, words []string, kubeconfigPath string) (cloudCommandPlan, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "eks":
		return buildEKSCommand(words)
	case "gke":
		return buildGKECommand(words)
	case "aks":
		return buildAKSCommand(words, kubeconfigPath)
	default:
		return cloudCommandPlan{}, errors.New("cloud provider must be eks, gke, or aks")
	}
}

func buildEKSCommand(words []string) (cloudCommandPlan, error) {
	rest, err := commandRemainder(words, "aws", "eks", "update-kubeconfig")
	if err != nil {
		return cloudCommandPlan{}, errors.New("paste an aws eks update-kubeconfig command")
	}
	values, _, err := parseCommandOptions(rest,
		map[string]string{"--name": "name", "--region": "region", "--profile": "profile", "--role-arn": "role", "--alias": "alias", "--user-alias": "user_alias"},
		nil,
	)
	if err != nil {
		return cloudCommandPlan{}, err
	}
	if values["name"] == "" {
		return cloudCommandPlan{}, errors.New("the EKS command must include --name")
	}
	args := []string{}
	for _, item := range []struct{ flag, key string }{{"--profile", "profile"}, {"--region", "region"}} {
		if values[item.key] != "" {
			args = append(args, item.flag, values[item.key])
		}
	}
	args = append(args, "eks", "update-kubeconfig", "--name", values["name"], "--dry-run")
	for _, item := range []struct{ flag, key string }{{"--role-arn", "role"}, {"--alias", "alias"}, {"--user-alias", "user_alias"}} {
		if values[item.key] != "" {
			args = append(args, item.flag, values[item.key])
		}
	}
	environment := map[string]string{}
	if values["profile"] != "" {
		environment["AWS_PROFILE"] = values["profile"]
	}
	return cloudCommandPlan{executable: "aws", args: args, name: values["name"], execAllowlist: []string{"aws"}, environment: environment, stdoutConfig: true}, nil
}

func buildGKECommand(words []string) (cloudCommandPlan, error) {
	rest, err := commandRemainder(words, "gcloud", "container", "clusters", "get-credentials")
	if err != nil {
		return cloudCommandPlan{}, errors.New("paste a gcloud container clusters get-credentials command")
	}
	values, booleans, err := parseCommandOptions(rest,
		map[string]string{"--location": "location", "--region": "region", "--zone": "zone", "-z": "zone", "--project": "project", "--account": "account", "--configuration": "configuration", "--impersonate-service-account": "impersonate"},
		map[string]string{"--internal-ip": "internal", "--dns-endpoint": "dns", "--quiet": "quiet"},
	)
	if err != nil {
		return cloudCommandPlan{}, err
	}
	if values["_positionals"] == "" || strings.ContainsRune(values["_positionals"], '\x00') {
		return cloudCommandPlan{}, errors.New("the GKE command must include one cluster name")
	}
	name := values["_positionals"]
	args := []string{"container", "clusters", "get-credentials", name}
	for _, item := range []struct{ flag, key string }{
		{"--location", "location"}, {"--region", "region"}, {"--zone", "zone"}, {"--project", "project"},
		{"--account", "account"}, {"--configuration", "configuration"}, {"--impersonate-service-account", "impersonate"},
	} {
		if values[item.key] != "" {
			args = append(args, item.flag, values[item.key])
		}
	}
	for _, item := range []struct{ flag, key string }{{"--internal-ip", "internal"}, {"--dns-endpoint", "dns"}, {"--quiet", "quiet"}} {
		if booleans[item.key] {
			args = append(args, item.flag)
		}
	}
	return cloudCommandPlan{executable: "gcloud", args: args, name: name, execAllowlist: []string{"gke-gcloud-auth-plugin", "gcloud"}}, nil
}

func buildAKSCommand(words []string, kubeconfigPath string) (cloudCommandPlan, error) {
	rest, err := commandRemainder(words, "az", "aks", "get-credentials")
	if err != nil {
		return cloudCommandPlan{}, errors.New("paste an az aks get-credentials command")
	}
	values, booleans, err := parseCommandOptions(rest,
		map[string]string{"--name": "name", "-n": "name", "--resource-group": "group", "-g": "group", "--subscription": "subscription", "--context": "context", "--format": "format"},
		map[string]string{"--admin": "admin", "-a": "admin", "--public-fqdn": "public"},
	)
	if err != nil {
		return cloudCommandPlan{}, err
	}
	if values["name"] == "" || values["group"] == "" {
		return cloudCommandPlan{}, errors.New("the AKS command must include --resource-group and --name")
	}
	if positionals := values["_positionals"]; positionals != "" {
		return cloudCommandPlan{}, errors.New("the AKS command contains an unexpected positional argument")
	}
	if format := values["format"]; format != "" && format != "azure" && format != "exec" {
		return cloudCommandPlan{}, errors.New("the AKS --format value must be azure or exec")
	}
	args := []string{"aks", "get-credentials", "--resource-group", values["group"], "--name", values["name"], "--file", kubeconfigPath, "--overwrite-existing"}
	for _, item := range []struct{ flag, key string }{{"--subscription", "subscription"}, {"--context", "context"}, {"--format", "format"}} {
		if values[item.key] != "" {
			args = append(args, item.flag, values[item.key])
		}
	}
	if booleans["admin"] {
		args = append(args, "--admin")
	}
	if booleans["public"] {
		args = append(args, "--public-fqdn")
	}
	return cloudCommandPlan{executable: "az", args: args, name: values["name"], execAllowlist: []string{"kubelogin", "az"}}, nil
}

func commandRemainder(words []string, executable string, subcommands ...string) ([]string, error) {
	if len(words) < 1+len(subcommands) || executableName(words[0]) != executable {
		return nil, errors.New("unexpected command")
	}
	for index, expected := range subcommands {
		if words[index+1] != expected {
			return nil, errors.New("unexpected command")
		}
	}
	return words[1+len(subcommands):], nil
}

func executableName(value string) string {
	name := strings.ToLower(filepath.Base(value))
	return strings.TrimSuffix(name, ".exe")
}

func parseCommandOptions(words []string, valueOptions, booleanOptions map[string]string) (map[string]string, map[string]bool, error) {
	values := map[string]string{}
	booleans := map[string]bool{}
	var positionals []string
	for index := 0; index < len(words); index++ {
		word := words[index]
		option := word
		inline := ""
		if strings.HasPrefix(word, "--") {
			if before, after, ok := strings.Cut(word, "="); ok {
				option, inline = before, after
			}
		}
		if key := valueOptions[option]; key != "" {
			value := inline
			if value == "" {
				index++
				if index >= len(words) {
					return nil, nil, fmt.Errorf("%s needs a value", option)
				}
				value = words[index]
			}
			if value == "" || strings.ContainsAny(value, "$`") {
				return nil, nil, fmt.Errorf("%s must contain a literal value, not a shell variable", option)
			}
			values[key] = value
			continue
		}
		if key := booleanOptions[option]; key != "" {
			if inline != "" && inline != "true" {
				return nil, nil, fmt.Errorf("%s only accepts true", option)
			}
			booleans[key] = true
			continue
		}
		if strings.HasPrefix(word, "-") {
			return nil, nil, fmt.Errorf("unsupported option %s", option)
		}
		if strings.ContainsAny(word, "$`") {
			return nil, nil, errors.New("replace shell variables with their literal values")
		}
		positionals = append(positionals, word)
	}
	values["_positionals"] = strings.Join(positionals, "\x00")
	return values, booleans, nil
}

func splitCommandWords(command string) ([]string, error) {
	command = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(command, "\\\r\n", " "), "\\\n", " "))
	if command == "" {
		return nil, errors.New("cloud credential command is required")
	}
	var words []string
	var current strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if current.Len() > 0 {
			words = append(words, current.String())
			current.Reset()
		}
	}
	for _, character := range command {
		switch {
		case escaped:
			current.WriteRune(character)
			escaped = false
		case character == '\\' && quote != '\'':
			escaped = true
		case quote != 0:
			if character == quote {
				quote = 0
			} else {
				current.WriteRune(character)
			}
		case character == '\'' || character == '"':
			quote = character
		case character == ' ' || character == '\t' || character == '\r' || character == '\n':
			flush()
		default:
			current.WriteRune(character)
		}
	}
	if escaped || quote != 0 {
		return nil, errors.New("cloud credential command has an unfinished quote or escape")
	}
	flush()
	return words, nil
}
