#!/usr/bin/env bash
# Launch an AgentBoard agent on this machine. It dials OUTBOUND to the hub, so
# this PC can sit behind NAT/a firewall.
#
# Required env (export before running, or put in this PC's ~/.profile):
#   AGENT_HUB_URL    e.g. wss://your-hub-host:12019/agent-ws
#   AGENT_TOKEN      must match the hub's AGENT_TOKEN
# Optional:
#   AGENT_HOST_ID    stable id (default: this machine's hostname)
#   AGENT_HOST_LABEL display name in the dashboard (default: host id)
#
# One-time setup on a fresh PC:
#   git clone <repo> && cd agentboard
#   python3.12 -m venv backend/.venv
#   backend/.venv/bin/pip install -r backend/requirements.txt
#   (tmux must be installed)
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, so `agent` and `backend` are importable

: "${AGENT_HUB_URL:?set AGENT_HUB_URL (e.g. wss://hub:12019/agent-ws)}"
: "${AGENT_TOKEN:?set AGENT_TOKEN (must match the hub)}"

PY="backend/.venv/bin/python"
[ -x "$PY" ] || PY="python3"

exec "$PY" -m agent.main
