# Contributing

Keep changes small enough to review and verify independently.

## Before opening a pull request

```sh
make check
make vuln
make race
make smoke
```

Use `make fix` to apply Go's supported source migrations and formatting before
committing. `make lint` and `make vuln` install their pinned analysis tools when
needed. UI changes should also be checked at desktop and narrow widths.

Do not commit runtime data, credentials, local tool configuration, compiled
binaries, or release archives. Remote agents are outside the `0.1.x` release
scope.

## Pull requests

- explain the user-visible behavior;
- keep unrelated cleanup separate;
- add or update tests for changed behavior;
- update documentation when commands, configuration, or supported behavior changes.
