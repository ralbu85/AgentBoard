#!/bin/bash
# E2E screen-fidelity test against a RUNNING AgentBoard server (default :3002).
#
# What it proves: the exact frames a browser receives (real WS protocol),
# replayed through headless xterm.js with the client's write sequences,
# reproduce tmux's pane byte-for-byte — visible area, 500-line burst
# scrollback continuity, CJK/emoji/box-drawing, and cursor position.
#
# Needs: server running locally, tmux, node, and the repo backend venv.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-fund --no-audit
PY=../../backend/.venv/bin/python
[ -x "$PY" ] || PY=python3
"$PY" collect.py
node replay.js
"$PY" compare.py
