# Kubernetes authentication

Runwake deliberately relies on kubeconfig semantics rather than defining provider-specific credentials.

## Kubeconfig path

Path mode is best for laptop use:

```text
~/.kube/config
```

Runwake reads the selected context and calls the Kubernetes API directly. No
`kubectl` executable is required. Referenced files are resolved relative to the
kubeconfig on the machine running Runwake. Supported fields include:

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

Runwake parses the submitted content directly, embeds its CA and client
certificate material, and encrypts the resulting minimal kubeconfig.

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

Direct API connections intentionally do not execute these external credential
binaries. Use a kubeconfig containing a static token or client certificate. For
example, OpenShift users can export the token-based kubeconfig produced after
login. Cloud-managed clusters may require a short-lived token to be refreshed
outside Runwake until native authentication for that provider is implemented.

## Hosted deployments

A hosted server cannot use a developer's local keychain, browser login session, or filesystem unless those resources are available to the Runwake process. Use a dedicated kubeconfig and credential-helper environment for hosted private-cluster access.
