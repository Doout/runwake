# Kubernetes authentication

Runwake deliberately relies on kubeconfig semantics rather than defining provider-specific credentials.

## Kubeconfig path

Path mode is best for laptop use:

```text
~/.kube/config
```

The kubeconfig and any referenced files are read by `kubectl` on the machine running Runwake. This supports fields such as:

```yaml
certificate-authority: /path/to/ca.crt
client-certificate: /path/to/client.crt
client-key: /path/to/client.key
```

Embedded forms work as well:

```yaml
certificate-authority-data: ...
client-certificate-data: ...
client-key-data: ...
```

## Uploaded kubeconfig

Runwake writes the submitted content to a mode-0600 temporary file and asks `kubectl` to produce a raw, flattened representation. The result is encrypted and the temporary file is removed.

A kubeconfig with file references can only be flattened if those files exist on the Runwake host at import time. Otherwise, flatten it before upload:

```sh
kubectl config view --raw --flatten > runwake.kubeconfig
```

## Exec credential plugins

Modern cloud kubeconfigs often contain:

```yaml
users:
  - name: cloud-user
    user:
      exec:
        command: aws
        args: [eks, get-token, ...]
```

The command executes where Runwake runs. The helper binary, its configuration files, and required environment variables must therefore exist there.

Examples:

| Platform | Typical helper or setup |
|---|---|
| AWS EKS | `aws eks get-token` through the `aws` CLI |
| OpenShift/OCP | token kubeconfig created by `oc login`, or an `oc`-based exec command |
| GKE | `gke-gcloud-auth-plugin` and `gcloud` configuration |
| AKS | Azure CLI and/or `kubelogin` |
| Other clouds | any conforming kubeconfig exec credential plugin |

Runwake does not bundle every cloud CLI in the default image. Extend the server image or mount the required executable and configuration.

## Policy

Before every Kubernetes operation, Runwake reads the selected, minified kubeconfig through `kubectl config view` and inspects the exec command.

- `deny`: no exec command may run;
- `allowlist`: the executable basename must match the configured list;
- `allow`: any command named by the kubeconfig may run.

The policy is a trust boundary. An exec-enabled kubeconfig can run a local program with the Runwake process environment and connection-specific overrides.

## Environment overrides

A direct Kubernetes connection can store environment variables such as:

```text
AWS_PROFILE=production
AWS_REGION=us-east-1
AZURE_CONFIG_DIR=/runwake/azure
CLOUDSDK_CONFIG=/runwake/gcloud
```

They are encrypted at rest and passed only to `kubectl` and the kubeconfig credential command for that connection.

Runwake validates environment variable names, disallows NUL bytes, limits the number of variables, and limits their total size.

## Hosted deployments

A hosted server cannot use a developer's local keychain, browser login session, or filesystem unless those resources are available to the Runwake process. Use a dedicated kubeconfig and credential-helper environment for hosted private-cluster access.
