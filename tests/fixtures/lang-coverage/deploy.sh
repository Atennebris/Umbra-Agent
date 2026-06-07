#!/usr/bin/env bash

set -euo pipefail

DEPLOY_ENV="${1:-staging}"

build_project() {
  echo "Building for $DEPLOY_ENV..."
  pnpm build
}

run_checks() {
  pnpm test
  pnpm lint
}

deploy() {
  local target="$1"
  echo "Deploying to $target"
}

build_project
run_checks
deploy "$DEPLOY_ENV"
