#!/bin/bash
# Run from anywhere — resolves to the repo root so `backend.main` imports work.
cd "$(dirname "$(readlink -f "$0")")"
PY=backend/.venv/bin/python
[ -x "$PY" ] || PY=python3
exec "$PY" -m backend.main
