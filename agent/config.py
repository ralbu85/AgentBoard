"""Agent configuration, all from environment variables.

  AGENT_HUB_URL    wss://<hub-host>:12019/agent-ws   (required)
  AGENT_TOKEN      shared secret matching the hub's AGENT_TOKEN (required)
  AGENT_HOST_ID    stable id for this machine (default: sanitized hostname)
  AGENT_HOST_LABEL human-friendly name shown in the dashboard (default: host id)
  AGENT_INSECURE   set to 1 to allow a plaintext ws:// hub url (NOT recommended)
"""
from __future__ import annotations

import os
import re
import socket

HUB_URL = os.getenv("AGENT_HUB_URL", "").strip()
TOKEN = os.getenv("AGENT_TOKEN", "")
INSECURE = os.getenv("AGENT_INSECURE", "") == "1"


def _sanitize_host(raw: str) -> str:
    """Coerce to ^[a-z0-9_-]{1,32}$ — the host id the hub will accept."""
    h = re.sub(r"[^a-z0-9_-]", "-", raw.lower()).strip("-")
    return (h or "agent")[:32]


HOST_ID = _sanitize_host(os.getenv("AGENT_HOST_ID", "") or socket.gethostname().split(".")[0])
HOST_LABEL = os.getenv("AGENT_HOST_LABEL", "") or HOST_ID
