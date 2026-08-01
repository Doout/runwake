package main

import "testing"

func TestEnvBool(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		want  bool
	}{
		{name: "unset", value: "", want: false},
		{name: "true", value: "true", want: true},
		{name: "one", value: "1", want: true},
		{name: "spaced", value: " TRUE ", want: true},
		{name: "false", value: "false", want: false},
		{name: "invalid", value: "enabled", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("RUNWAKE_TEST_BOOL", test.value)
			if got := envBool("RUNWAKE_TEST_BOOL"); got != test.want {
				t.Fatalf("envBool() = %t, want %t", got, test.want)
			}
		})
	}
}
