package activity

import (
	"strconv"
	"strings"

	"github.com/Doout/runwake/internal/model"
)

const maxEnrichmentLineBytes = 16 * 1024

type logEnricher func(string) (map[string]any, string, bool)

var rawLogEnrichers = [...]logEnricher{
	enrichUvicornAccessLog,
	enrichCommonAccessLog,
}

func enrichActivityRecord(record *model.ActivityRecord) {
	if record == nil || record.Type != "log" || record.Message == "" || len(record.Message) > maxEnrichmentLineBytes {
		return
	}
	for _, enrich := range rawLogEnrichers {
		fields, level, ok := enrich(record.Message)
		if !ok {
			continue
		}
		if record.Fields == nil {
			record.Fields = make(map[string]any, len(fields))
		}
		for key, value := range fields {
			if _, exists := record.Fields[key]; !exists {
				record.Fields[key] = value
			}
		}
		if level != "" && (record.Level == "" || record.Level == "log" || record.Level == "stdout" || record.Level == "stderr") {
			record.Level = strings.ToLower(level)
		}
		return
	}
}

func enrichUvicornAccessLog(line string) (map[string]any, string, bool) {
	value := strings.TrimSpace(line)
	colon := strings.IndexByte(value, ':')
	if colon < 1 || colon > 8 {
		return nil, "", false
	}
	level := canonicalLogLevel(value[:colon])
	if level == "" {
		return nil, "", false
	}
	rest := strings.TrimSpace(value[colon+1:])
	separator := strings.Index(rest, ` - "`)
	if separator < 1 {
		return nil, "", false
	}
	client := strings.TrimSpace(rest[:separator])
	requestAndStatus := rest[separator+4:]
	closingQuote := strings.IndexByte(requestAndStatus, '"')
	if closingQuote < 1 {
		return nil, "", false
	}
	requestLine := requestAndStatus[:closingQuote]
	statusText := strings.TrimSpace(requestAndStatus[closingQuote+1:])
	fields, ok := httpAccessFields(client, requestLine, statusText)
	if !ok {
		return nil, "", false
	}
	fields["level"] = level
	fields["log_format"] = "uvicorn_access"
	return fields, level, true
}

func enrichCommonAccessLog(line string) (map[string]any, string, bool) {
	value := strings.TrimSpace(line)
	if !strings.Contains(value, " HTTP/") {
		return nil, "", false
	}
	openQuote := strings.IndexByte(value, '"')
	if openQuote < 1 {
		return nil, "", false
	}
	afterOpen := value[openQuote+1:]
	closeQuote := strings.IndexByte(afterOpen, '"')
	if closeQuote < 1 {
		return nil, "", false
	}
	prefix := strings.Fields(value[:openQuote])
	if len(prefix) == 0 {
		return nil, "", false
	}
	fields, ok := httpAccessFields(prefix[0], afterOpen[:closeQuote], strings.TrimSpace(afterOpen[closeQuote+1:]))
	if !ok {
		return nil, "", false
	}
	fields["log_format"] = "common_access"
	return fields, "", true
}

func httpAccessFields(client, requestLine, statusText string) (map[string]any, bool) {
	request := strings.Fields(requestLine)
	status := strings.Fields(statusText)
	if len(request) != 3 || !strings.HasPrefix(strings.ToUpper(request[2]), "HTTP/") || len(status) == 0 {
		return nil, false
	}
	statusCode, err := strconv.Atoi(status[0])
	if err != nil || statusCode < 100 || statusCode > 599 {
		return nil, false
	}
	method := strings.ToUpper(request[0])
	target := request[1]
	path, query := splitHTTPTarget(target)
	address, port := splitClientAddress(client)
	fields := map[string]any{
		"logger":            "http",
		"log_kind":          "http_access",
		"message":           method + " " + path,
		"http_method":       method,
		"http_target":       target,
		"http_path":         path,
		"http_protocol":     strings.ToUpper(request[2]),
		"http_status":       statusCode,
		"http_status_class": strconv.Itoa(statusCode/100) + "xx",
		"client":            client,
		"client_address":    address,
	}
	if query != "" {
		fields["http_query"] = query
	}
	if port != "" {
		fields["client_port"] = port
	}
	if len(status) > 1 {
		fields["http_status_text"] = strings.Join(status[1:], " ")
	}
	return fields, true
}

func splitHTTPTarget(target string) (string, string) {
	if before, after, ok := strings.Cut(target, "?"); ok {
		return before, after
	}
	return target, ""
}

func splitClientAddress(client string) (string, string) {
	if strings.HasPrefix(client, "[") {
		if end := strings.LastIndex(client, "]:"); end > 1 {
			return client[1:end], client[end+2:]
		}
	}
	if colon := strings.LastIndexByte(client, ':'); colon > 0 && !strings.Contains(client[:colon], ":") {
		return client[:colon], client[colon+1:]
	}
	return client, ""
}

func canonicalLogLevel(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "TRACE":
		return "TRACE"
	case "DEBUG":
		return "DEBUG"
	case "INFO":
		return "INFO"
	case "WARN", "WARNING":
		return "WARN"
	case "ERROR":
		return "ERROR"
	case "FATAL", "CRITICAL":
		return "FATAL"
	default:
		return ""
	}
}
