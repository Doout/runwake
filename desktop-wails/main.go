package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	core "github.com/Doout/runwake/internal/app"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed frontend/dist/*
var embedded embed.FS

type desktopShell struct {
	server       *core.RunningServer
	cancel       context.CancelFunc
	navigateOnce sync.Once
}

func (d *desktopShell) domReady(ctx context.Context) {
	// The Runwake UI talks to the same loopback HTTP/SSE API used by the hosted
	// build. Navigating the WebView directly avoids Wails v2 AssetServer response
	// streaming limitations on Windows. OnDomReady also fires after this
	// navigation, so it must not redirect the loaded Runwake page again.
	d.navigateOnce.Do(func() {
		wailsruntime.WindowExecJS(ctx, fmt.Sprintf("window.location.replace(%q)", d.server.URL))
	})
}

func (d *desktopShell) shutdown(parent context.Context) {
	d.cancel()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), time.Second)
	defer cancel()
	_ = d.server.Shutdown(ctx)
}

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(core.Version)
		return
	}
	if bindingGeneration {
		if err := wails.Run(&options.App{}); err != nil {
			log.Fatal(err)
		}
		return
	}
	assets, err := fs.Sub(embedded, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	serverCtx, cancel := context.WithCancel(context.Background())
	running, err := core.Start(serverCtx, core.ServerConfig{
		Listen:                "127.0.0.1:0",
		DataDir:               core.DefaultDataDir(),
		OpenBrowser:           false,
		AutoConnectDocker:     true,
		InvestigationsEnabled: environmentEnabled("RUNWAKE_ENABLE_INVESTIGATIONS"),
		Logger:                slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	if err != nil {
		cancel()
		log.Fatal(err)
	}
	shell := &desktopShell{server: running, cancel: cancel}
	if err := wails.Run(&options.App{
		Title:                    "Runwake",
		Width:                    1240,
		Height:                   780,
		MinWidth:                 900,
		MinHeight:                600,
		BackgroundColour:         &options.RGBA{R: 13, G: 15, B: 18, A: 255},
		AssetServer:              &assetserver.Options{Assets: assets},
		OnDomReady:               shell.domReady,
		OnShutdown:               shell.shutdown,
		EnableDefaultContextMenu: false,
	}); err != nil {
		shell.shutdown(context.Background())
		log.Fatal(err)
	}
}

func environmentEnabled(key string) bool {
	value, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(key)))
	return err == nil && value
}
