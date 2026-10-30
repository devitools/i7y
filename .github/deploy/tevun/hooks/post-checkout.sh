#!/usr/bin/env bash
set -eu
cd "$1"
docker compose up -d --remove-orphans
