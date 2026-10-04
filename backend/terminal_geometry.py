"""Desktop source geometry; mobile rendering never resizes a running process."""
from __future__ import annotations
import time

LEASE_SECONDS = 15

class Viewports:
    def __init__(self):
        self.requests: dict[str, dict[int, tuple[int | None, float]]] = {}
        self.owners: dict[str, int] = {}

    def viewers(self, sid: str) -> dict[int, tuple[int | None, float]]:
        now = time.monotonic()
        current = {client: value for client, value in self.requests.get(sid, {}).items() if now-value[1]<LEASE_SECONDS}
        if current:
            self.requests[sid] = current
        else:
            self.requests.pop(sid, None)
        if self.owners.get(sid) not in current or current.get(self.owners.get(sid), (None, 0))[0] is None:
            self.owners.pop(sid, None)
        return current

    def update(self, sid: str, client: int, cols: int | None) -> bool:
        current = self.viewers(sid)
        current[client] = (cols, time.monotonic())
        self.requests[sid] = current
        if self.owners.get(sid) == client and cols is None:
            self.owners.pop(sid, None)
        if sid not in self.owners:
            desktop = next((c for c, (width, _) in current.items() if width is not None), None)
            if desktop is not None:
                self.owners[sid] = desktop
        return cols is not None and self.owners.get(sid) == client

    def release(self, client: int, sid: str | None = None):
        for key in [sid] if sid else list(self.requests):
            self.requests.get(key, {}).pop(client, None)
            self.viewers(key)

    def target_columns(self, sid: str) -> int | None:
        current = self.viewers(sid)
        # Phones wrap the captured output locally at their own readable width.
        # Opening/closing a phone must never reflow the process's shared grid.
        return current.get(self.owners.get(sid), (None, 0))[0]

    def sessions(self) -> set[str]:
        return {sid for sid in list(self.requests) if self.viewers(sid)}

viewports = Viewports()


class FrameText(str):
    """ANSI text with optional source soft-wrap boundaries (JSON remains text)."""
    def __new__(cls, text, wrapped_rows=None):
        value = super().__new__(cls, text)
        value.wrapped_rows = wrapped_rows
        return value


def frame_meta(session=None, data=None):
    meta = {'cols': getattr(session, 'display_cols', 80), 'rows': getattr(session, 'display_rows', 40),
            'fullRows': True, 'dynamicWidth': True, 'gridVersion': getattr(session, 'grid_revision', 0)}
    if getattr(data, 'wrapped_rows', None) is not None:
        meta['wrappedRows'] = data.wrapped_rows
    return meta


def stable(session, revision):
    return (not getattr(session, 'resizing', False)
            and getattr(session, 'geometry_verified', True)
            and getattr(session, 'grid_revision', 0) == revision)
