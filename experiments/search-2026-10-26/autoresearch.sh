#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node experiments/search-2026-10-26/benchmark.mjs "$@"
