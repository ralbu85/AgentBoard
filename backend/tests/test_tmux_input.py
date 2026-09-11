import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from backend import tmux


@pytest.mark.parametrize("text", ["--", "--help", "-n", "한글 --option", "—"])
def test_literal_input_is_not_parsed_as_tmux_options(text):
    with patch.object(tmux, "tmux_run", new_callable=AsyncMock) as run:
        asyncio.run(tmux.send_keys("test-session", text, literal=True))
    run.assert_awaited_once_with(["send-keys", "-t", "test-session", "-l", "--", text])


def test_named_key_still_uses_key_mode():
    with patch.object(tmux, "tmux_run", new_callable=AsyncMock) as run:
        asyncio.run(tmux.send_keys("test-session", "Enter"))
    run.assert_awaited_once_with(["send-keys", "-t", "test-session", "--", "Enter"])
