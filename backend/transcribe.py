"""Speech to text for the input card (🎤).

One Whisper worker process (`whisper_worker.py`, run with WHISPER_PYTHON) is
started on first use and keeps the model loaded, so later requests take a
fraction of a second. It is stopped after IDLE_SECONDS without a request,
which gives the shared GPU its memory back. Requests run one at a time.
"""
from __future__ import annotations

import asyncio
import collections
import json
import os
import time
from pathlib import Path

from . import config
from .logger import log

IDLE_SECONDS = 600
START_TIMEOUT = 300      # loading the model; the first run may also fetch it
REQUEST_TIMEOUT = 180
WORKER = Path(__file__).with_name('whisper_worker.py')


class TranscribeError(Exception):
    pass


class Transcriber:
    def __init__(self, worker: Path = WORKER):
        self.worker = worker
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.used = 0.0
        self.stderr: collections.deque[str] = collections.deque(maxlen=20)
        self.reaper: asyncio.Task | None = None
        self.warming: asyncio.Task | None = None

    @property
    def available(self) -> bool:
        return bool(config.WHISPER_PYTHON)

    async def _drain(self, proc: asyncio.subprocess.Process):
        assert proc.stderr
        async for line in proc.stderr:
            self.stderr.append(line.decode(errors='replace').rstrip())

    async def _start(self):
        env = {**os.environ, 'AGENTBOARD_WHISPER_MODEL': config.WHISPER_MODEL}
        # -I: the worker's folder (this package) must not shadow its imports.
        proc = await asyncio.create_subprocess_exec(
            config.WHISPER_PYTHON, '-I', str(self.worker), env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        asyncio.get_running_loop().create_task(self._drain(proc))
        self.proc = proc
        try:
            ready = await self._read(START_TIMEOUT)
        except TranscribeError:
            await self.stop()
            raise
        if not ready.get('ready'):
            await self.stop()
            raise TranscribeError('음성 인식 모델을 불러오지 못했습니다.')
        log.info('whisper worker ready (%s)', config.WHISPER_MODEL)
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.get_running_loop().create_task(self._reap())

    async def _read(self, timeout: float) -> dict:
        assert self.proc and self.proc.stdout
        try:
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
        except asyncio.TimeoutError:
            raise TranscribeError('음성 인식이 너무 오래 걸려 중단했습니다.') from None
        if not line:
            detail = next((l for l in reversed(self.stderr) if l.strip()), '')
            log.warning('whisper worker exited: %s', detail)
            raise TranscribeError('음성 인식 프로그램이 종료되었습니다.' + (f' ({detail[-200:]})' if detail else ''))
        try:
            return json.loads(line)
        except ValueError:
            raise TranscribeError('음성 인식 결과를 읽지 못했습니다.') from None

    async def transcribe(self, path: Path) -> str:
        if not self.available:
            raise TranscribeError('이 서버에는 음성 인식이 설정되어 있지 않습니다.')
        async with self.lock:
            try:
                if self.proc is None or self.proc.returncode is not None:
                    await self._start()
                assert self.proc and self.proc.stdin
                request = {'path': str(path), 'language': config.WHISPER_LANGUAGE or None}
                self.proc.stdin.write((json.dumps(request) + '\n').encode())
                await self.proc.stdin.drain()
                reply = await self._read(REQUEST_TIMEOUT)
            except TranscribeError:
                await self.stop()   # a stuck or dead worker is started afresh next time
                raise
            except (OSError, ConnectionError) as e:
                await self.stop()
                raise TranscribeError(f'음성 인식 프로그램을 실행하지 못했습니다: {e}') from None
            finally:
                self.used = time.monotonic()
        if 'error' in reply:
            log.warning('whisper failed: %s', reply['error'])
            raise TranscribeError('음성을 글자로 바꾸지 못했습니다. 녹음 형식을 확인해 주세요.')
        return str(reply.get('text', '')).strip()

    def warm(self):
        """Load the model while someone is still speaking, so their words don't wait for it."""
        async def start():
            async with self.lock:
                if self.proc is None or self.proc.returncode is not None:
                    try:
                        await self._start()
                    except (TranscribeError, OSError) as e:
                        log.warning('whisper warm-up failed: %s', e)
                    self.used = time.monotonic()
        if self.available and (self.warming is None or self.warming.done()):
            self.warming = asyncio.get_running_loop().create_task(start())

    async def _reap(self):
        while self.proc is not None:
            await asyncio.sleep(30)
            if self.lock.locked() or time.monotonic() - self.used <= IDLE_SECONDS:
                continue
            async with self.lock:
                if self.proc is not None and time.monotonic() - self.used > IDLE_SECONDS:
                    await self.stop()
                    log.info('whisper worker stopped after being idle')

    async def stop(self):
        proc, self.proc = self.proc, None
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()


transcriber = Transcriber()
