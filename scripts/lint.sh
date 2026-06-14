#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npx biome check . --no-errors-on-unmatched 2>&1 || true
