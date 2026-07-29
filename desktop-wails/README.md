# Runwake desktop shell

This is a thin Wails v2 shell around the same loopback server and embedded UI used by `runwake serve`.

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
cd desktop-wails
wails build
```

On Linux systems that use WebKitGTK 4.1, build with:

```sh
wails build -tags webkit2_41
```

The shell intentionally navigates its WebView to Runwake's local HTTP origin. Live log streams therefore use native HTTP/SSE rather than the Wails asset bridge.
