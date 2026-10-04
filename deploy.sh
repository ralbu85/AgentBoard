#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")" && pwd)"
task_stage="$(mktemp -d /tmp/agentboard-build.XXXXXXXX)"
trap 'rm -rf -- "$task_stage"' EXIT
npm --prefix "$task_root/frontend" run build -- --outDir "$task_stage"
cd "$task_root"
"$task_root/backend/.venv/bin/python" -m backend.release "$task_stage" --restart
