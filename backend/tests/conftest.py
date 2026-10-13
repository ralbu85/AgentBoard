import sys
from pathlib import Path

# Make `import backend.*` work regardless of pytest's invocation directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import pytest


@pytest.fixture(autouse=True)
def isolated_shared_session_state(tmp_path, monkeypatch):
    from backend import session_state
    monkeypatch.setattr(session_state, 'state', session_state.SessionState(tmp_path / 'session-state.json'))
    from backend import recent_work
    monkeypatch.setattr(recent_work, 'state', recent_work.RecentWork(tmp_path / 'recent-work.json'))
