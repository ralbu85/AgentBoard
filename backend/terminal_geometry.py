"""Desktop source geometry; mobile rendering never resizes a running process."""
from __future__ import annotations
import time

LEASE_SECONDS = 15
# Idle sessions join the shared width once the layout settles. A session just
# left keeps its width briefly, so flipping tabs in a split doesn't reflow it.
SHARED_SETTLE_SECONDS = 3
RELEASE_GRACE_SECONDS = 30
# A width change redraws the app; that output is neither activity nor a state change.
REFLOW_QUIET_SECONDS = 4

class Viewports:
    def __init__(self):
        self.requests: dict[str, dict[int, tuple[int | None, float]]] = {}
        self.owners: dict[str, int] = {}
        self.released: dict[str, float] = {}
        self.shared_cols: int | None = None
        self.shared_at = 0.0

    def _drop_owner(self, sid: str):
        if self.owners.pop(sid, None) is not None:
            self.released[sid] = time.monotonic()

    def viewers(self, sid: str) -> dict[int, tuple[int | None, float]]:
        now = time.monotonic()
        current = {client: value for client, value in self.requests.get(sid, {}).items() if now-value[1]<LEASE_SECONDS}
        if current:
            self.requests[sid] = current
        else:
            self.requests.pop(sid, None)
        if self.owners.get(sid) not in current or current.get(self.owners.get(sid), (None, 0))[0] is None:
            self._drop_owner(sid)
        return current

    def update(self, sid: str, client: int, cols: int | None, claim: bool = False) -> bool:
        current = self.viewers(sid)
        current[client] = (cols, time.monotonic())
        self.requests[sid] = current
        if self.owners.get(sid) == client and cols is None:
            self._drop_owner(sid)
        # The window someone is using outranks one left open elsewhere.
        if claim and cols is not None:
            self.owners[sid] = client
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

    def set_shared_width(self, cols: int, claim: bool = False):
        if (claim or self.shared_cols is None) and cols != self.shared_cols:
            self.shared_cols, self.shared_at = cols, time.monotonic()

    def idle_target(self, sid: str) -> int | None:
        """The shared width, for a session no desktop is currently fitting."""
        now = time.monotonic()
        if self.shared_cols is None or now - self.shared_at < SHARED_SETTLE_SECONDS:
            return None
        if self.target_columns(sid) is not None:
            return None
        if sid in self.released:
            if now - self.released[sid] < RELEASE_GRACE_SECONDS:
                return None
            self.released.pop(sid)
        return self.shared_cols

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
