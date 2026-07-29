# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.26-alpine
ARG ALPINE_IMAGE=alpine:3.24

FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY cmd ./cmd
COPY internal ./internal
COPY webembed ./webembed
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X github.com/Doout/runwake/internal/app.Version=${VERSION}" \
    -o /out/runwake ./cmd/runwake

FROM ${ALPINE_IMAGE} AS runtime-base
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 runwake \
    && adduser -S -D -H -u 10001 -G runwake runwake \
    && mkdir -p /data \
    && chown -R runwake:runwake /data
COPY --from=build /out/runwake /usr/local/bin/runwake
EXPOSE 8080
VOLUME ["/data"]
USER 10001:10001
ENTRYPOINT ["runwake", "serve", "--listen", "0.0.0.0:8080", "--data-dir", "/data"]

# The image is dependency-free and talks directly to runtime APIs.
FROM runtime-base AS runwake
