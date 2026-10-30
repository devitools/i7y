#!/bin/sh
set -eu
cd "$(dirname "$0")"
version=${I7Y_AGENT_VERSION:-0.1.9}
windows_version=${I7Y_WINDOWS_AGENT_VERSION:-0.1.11}
mkdir -p dist
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -buildvcs=false -ldflags="-s -w -X main.version=$version" -o "dist/i7y-agent-linux-$arch" ./cmd/i7y-agent
done
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags="-s -w -X main.version=$windows_version" -o dist/i7y-host-windows-amd64.exe ./cmd/i7y-host-windows
(cd dist && if command -v sha256sum >/dev/null 2>&1; then sha256sum i7y-agent-linux-* i7y-host-windows-*; else shasum -a 256 i7y-agent-linux-* i7y-host-windows-*; fi > SHA256SUMS)
