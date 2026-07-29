package server

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildEKSCommand(t *testing.T) {
	words, err := splitCommandWords(`aws eks update-kubeconfig --region us-east-1 --name "payments" --profile production`)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildCloudCommandPlan("eks", words, "/unused")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--profile", "production", "--region", "us-east-1", "eks", "update-kubeconfig", "--name", "payments", "--dry-run"}
	if !reflect.DeepEqual(plan.args, want) {
		t.Fatalf("args=%q want=%q", plan.args, want)
	}
	if plan.executable != "aws" || !plan.stdoutConfig || plan.environment["AWS_PROFILE"] != "production" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
}

func TestBuildGKECommand(t *testing.T) {
	words, err := splitCommandWords("gcloud container clusters get-credentials checkout --location=us-central1 --project platform --internal-ip")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildCloudCommandPlan("gke", words, "/tmp/config")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"container", "clusters", "get-credentials", "checkout", "--location", "us-central1", "--project", "platform", "--internal-ip"}
	if !reflect.DeepEqual(plan.args, want) {
		t.Fatalf("args=%q want=%q", plan.args, want)
	}
	if plan.name != "checkout" || plan.executable != "gcloud" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
}

func TestBuildAKSCommand(t *testing.T) {
	words, err := splitCommandWords("az aks get-credentials --resource-group platform --name production --subscription sub-1")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildCloudCommandPlan("aks", words, "/tmp/runwake-config")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"aks", "get-credentials", "--resource-group", "platform", "--name", "production", "--file", "/tmp/runwake-config", "--overwrite-existing", "--subscription", "sub-1"}
	if !reflect.DeepEqual(plan.args, want) {
		t.Fatalf("args=%q want=%q", plan.args, want)
	}
	if plan.name != "production" || plan.executable != "az" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
}

func TestCloudCommandRejectsUnknownOptionsAndShellVariables(t *testing.T) {
	tests := []struct {
		provider string
		command  string
		contains string
	}{
		{"eks", "aws eks update-kubeconfig --name prod --kubeconfig /tmp/other", "unsupported option"},
		{"gke", "gcloud container clusters get-credentials $CLUSTER --location us-east1", "literal values"},
		{"aks", "az aks get-credentials --resource-group prod --name cluster --file /tmp/other", "unsupported option"},
	}
	for _, test := range tests {
		words, err := splitCommandWords(test.command)
		if err != nil {
			t.Fatal(err)
		}
		_, err = buildCloudCommandPlan(test.provider, words, "/tmp/config")
		if err == nil || !strings.Contains(err.Error(), test.contains) {
			t.Fatalf("%s error=%v, want %q", test.provider, err, test.contains)
		}
	}
}
