.PHONY: build test race run fix fmt format-check vet lint-install lint vuln-install vuln check web-build web-check upgrade-check release cross-build docker desktop desktop-install desktop-build desktop-dev smoke clean

VERSION ?= 0.1.0
WAILS_VERSION ?= v2.13.0
WAILS_BIN ?= $(shell go env GOPATH)/bin/wails
GOLANGCI_LINT_VERSION ?= v2.12.2
GOLANGCI_LINT_BIN ?= $(shell go env GOPATH)/bin/golangci-lint
GOVULNCHECK_VERSION ?= v1.6.0
GOVULNCHECK_BIN ?= $(shell go env GOPATH)/bin/govulncheck

build:
	mkdir -p bin
	rm -f bin/runwake-agent
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/Doout/runwake/internal/app.Version=$(VERSION)" -o bin/runwake ./cmd/runwake

test:
	go test ./...
	cd desktop-wails && go test ./...

race:
	go test -race ./...
	cd desktop-wails && go test -race ./...

fix:
	go fix ./...
	cd desktop-wails && go fix ./...
	$(MAKE) fmt

fmt:
	gofmt -w $$(find cmd internal webembed -name '*.go')
	cd desktop-wails && gofmt -w *.go

format-check:
	@test -z "$$(gofmt -l $$(find cmd internal webembed -name '*.go') $$(find desktop-wails -maxdepth 1 -name '*.go'))" || { \
		echo "Go files need formatting. Run 'make fmt'."; \
		gofmt -l $$(find cmd internal webembed -name '*.go') $$(find desktop-wails -maxdepth 1 -name '*.go'); \
		exit 1; \
	}

vet:
	go vet ./...
	cd desktop-wails && go vet ./...

lint-install:
	@if [ ! -x "$(GOLANGCI_LINT_BIN)" ] || [ "$$("$(GOLANGCI_LINT_BIN)" version --short 2>/dev/null)" != "$(patsubst v%,%,$(GOLANGCI_LINT_VERSION))" ]; then \
		echo "installing golangci-lint $(GOLANGCI_LINT_VERSION)"; \
		go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION); \
	fi

lint: lint-install
	"$(GOLANGCI_LINT_BIN)" run ./...
	cd desktop-wails && "$(GOLANGCI_LINT_BIN)" run --config ../.golangci.yml ./...

vuln-install:
	@if [ ! -x "$(GOVULNCHECK_BIN)" ] || ! "$(GOVULNCHECK_BIN)" -version 2>&1 | grep -Fq "Scanner: govulncheck@$(GOVULNCHECK_VERSION)"; then \
		echo "installing govulncheck $(GOVULNCHECK_VERSION)"; \
		go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION); \
	fi

vuln: vuln-install
	"$(GOVULNCHECK_BIN)" ./...
	cd desktop-wails && "$(GOVULNCHECK_BIN)" ./...

check: format-check test vet lint
	$(MAKE) web-check
	node --check webembed/dist/app.js
	node --check webembed/dist/personal.js
	node webembed/personal_test.js
	node --check webembed/dist/navigation.js
	node webembed/navigation_test.js
	node --check webembed/dist/terminal-text.js
	node webembed/terminal_text_test.js

web-build:
	./scripts/build-web.sh

web-check:
	./scripts/build-web.sh --check

upgrade-check:
	./scripts/check-upgrade.sh

run:
	go run ./cmd/runwake serve --data-dir ./data --open

release cross-build:
	./scripts/build-release.sh "$(VERSION)"

docker:
	docker build -t runwake:$(VERSION) .

desktop-install:
	@if [ ! -x "$(WAILS_BIN)" ]; then \
		echo "installing Wails $(WAILS_VERSION)"; \
		go install github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION); \
	fi

desktop-build: desktop-install
	cd desktop-wails && "$(WAILS_BIN)" build -m -nosyncgomod -trimpath -ldflags "-s -w -X github.com/Doout/runwake/internal/app.Version=$(VERSION)"
	./scripts/build-macos-icon.sh "$(VERSION)"

desktop: desktop-build
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		open desktop-wails/build/bin/Runwake.app; \
	else \
		echo "desktop launch is currently configured for macOS; the application was built successfully"; \
	fi

desktop-dev: desktop-install
	cd desktop-wails && "$(WAILS_BIN)" dev

smoke: build
	RUNWAKE_VERSION="$(VERSION)" ./scripts/smoke.sh

clean:
	rm -rf bin dist desktop-wails/build
