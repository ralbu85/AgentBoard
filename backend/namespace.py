"""Session-id namespacing across machines.

Hub-local sessions keep bare numeric ids ("1", "2"); their host is implicitly
"local". Remote agent sessions are exposed to browsers as "<host>:<localId>".

Translation happens in exactly two places:
  - ingest  (agent_ws): prefix_msg() tags an agent->browser message with host
  - egress  (ws / routes_session): split_id() routes a browser command back to
    the owning agent (or local) with the bare id restored.
"""
from __future__ import annotations

LOCAL = "local"


def split_id(prefixed_id: str) -> tuple[str, str]:
    """'office:3' -> ('office','3');  '5' -> ('local','5');  '' -> ('local','')."""
    if not prefixed_id:
        return LOCAL, ""
    # Split on the FIRST colon only. Local ids are numeric (never contain ':').
    if ":" in prefixed_id:
        host, local = prefixed_id.split(":", 1)
        return host, local
    return LOCAL, prefixed_id


def prefix_id(host: str, local_id: str) -> str:
    if host == LOCAL:
        return local_id
    return f"{host}:{local_id}"


def prefix_msg(host: str, label: str, msg: dict) -> dict:
    """Tag an agent->browser message with its origin host and prefix ids.

    This is the ONLY place agent events get their browser-facing id, so a bare
    id can never leak through and collide with a local session.
    """
    out = dict(msg)
    if isinstance(out.get("id"), str):
        out["id"] = prefix_id(host, out["id"])
    if out.get("type") == "titles" and isinstance(out.get("titles"), dict):
        out["titles"] = {prefix_id(host, k): v for k, v in out["titles"].items()}
    out["host"] = host
    out["hostLabel"] = label
    return out
