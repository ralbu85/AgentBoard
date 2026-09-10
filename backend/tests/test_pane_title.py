import asyncio
from backend import tmux


def test_display_info_preserves_automatic_title_with_separator(monkeypatch):
    async def run(args):
        return '/project|codex|123|456|1|문서 검토 | project\n'
    monkeypatch.setattr(tmux, 'tmux_run', run)
    info = asyncio.run(tmux.display_info('term-test'))
    assert info['auto_title'] == '문서 검토 | project'
    assert info['alt_screen'] is True
    assert info['pid'] == 456


def test_display_info_accepts_missing_title(monkeypatch):
    async def run(args):
        return '/project|bash|123|456|0'
    monkeypatch.setattr(tmux, 'tmux_run', run)
    assert asyncio.run(tmux.display_info('term-test'))['auto_title'] == ''
