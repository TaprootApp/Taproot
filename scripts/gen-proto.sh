#!/usr/bin/env bash
# Regenerates networking/gen from every .proto file in networking/src.
# Serialized with a lock so parallel builds can't interleave their output.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/taproot-proto.lock
flock 9
npm run build --workspace=networking
