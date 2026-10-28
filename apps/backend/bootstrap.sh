#!/bin/sh
set -eu
version=0.40.4
case "$(uname -m)" in
  x86_64) arch=amd64; checksum=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa ;;
  aarch64) arch=arm64; checksum=86095bf8ed9345954f0d2bf0a5fb9b57584ae60b77ebf3b6cd23a8003a3fd418 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
binary="/pb/bin/$version/pocketbase"
if [ ! -x "$binary" ] || [ ! -f /pb/bin/ca-certificates.crt ]; then
  apk add --no-cache ca-certificates wget unzip
  archive=$(mktemp)
  trap 'rm -f "$archive"' EXIT
  wget -q -O "$archive" "https://github.com/pocketbase/pocketbase/releases/download/v$version/pocketbase_${version}_linux_${arch}.zip"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
  mkdir -p "/pb/bin/$version"
  unzip -oq "$archive" pocketbase -d "/pb/bin/$version"
  cp /etc/ssl/certs/ca-certificates.crt /pb/bin/ca-certificates.crt
fi
export SSL_CERT_FILE=/pb/bin/ca-certificates.crt
exec "$binary" "$@"
