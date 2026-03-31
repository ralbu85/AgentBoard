from __future__ import annotations

import asyncio
import re
from . import config


_proc: asyncio.subprocess.Process | None = None
_task: asyncio.Task | None = None
_url: str | None = None
_broadcast = None

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def set_broadcast(fn):
    global _broadcast
    _broadcast = fn


def get_url() -> str | None:
    return _url


async def start():
    global _task
    _task = asyncio.create_task(_run_loop())


async def stop():
    global _proc, _task
    if _proc:
        _proc.terminate()
        _proc = None
    if _task:
        _task.cancel()
        _task = None


async def _run_loop():
    global _proc, _url
    while True:
        try:
            _proc = await asyncio.create_subprocess_exec(
                "cloudflared", "tunnel", "--url", f"http://localhost:{config.PORT}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            async def read_stream(stream):
                global _url
                while True:
                    line = await stream.readline()
                    if not line:
                        break
                    text = line.decode("utf-8", errors="replace")
                    m = URL_RE.search(text)
                    if m:
                        _url = m.group(0)
                        if _broadcast:
                            _broadcast({"type": "tunnel", "url": _url})
                        if config.DISCORD_WEBHOOK:
                            await _post_discord(_url)

            await asyncio.gather(
                read_stream(_proc.stdout),
                read_stream(_proc.stderr),
            )
            await _proc.wait()
        except asyncio.CancelledError:
            break
        except Exception:
            pass

        _url = None
        await asyncio.sleep(5)


async def _post_discord(url: str):
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-X", "POST", config.DISCORD_WEBHOOK,
            "-H", "Content-Type: application/json",
            "-d", f'{{"content":"🔗 TermHub tunnel: {url}"}}',
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except Exception:
        pass
