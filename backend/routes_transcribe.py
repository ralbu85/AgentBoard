"""REST: voice input. The browser records, this server's Whisper writes it out."""
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .auth import verify
from .transcribe import TranscribeError, transcriber

router = APIRouter(prefix="/api")

# About ten minutes of Opus speech; a longer recording is cut off in the browser first.
MAX_AUDIO_BYTES = 25 * 1024 * 1024


@router.get("/transcribe")
async def transcribe_available(_=Depends(verify)):
    return {"available": transcriber.available}


@router.post("/transcribe/warm")
async def transcribe_warm(_=Depends(verify)):
    transcriber.warm()
    return {"ok": transcriber.available}


@router.post("/transcribe")
async def transcribe(request: Request, _=Depends(verify)):
    if not transcriber.available:
        return JSONResponse({"ok": False, "error": "이 서버에는 음성 인식이 설정되어 있지 않습니다."}, 503)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(prefix='agentboard-voice-', suffix='.audio', delete=False) as f:
            tmp = Path(f.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    return JSONResponse({"ok": False, "error": "녹음이 너무 깁니다. 나눠서 녹음해 주세요."}, 413)
                f.write(chunk)
        if size == 0:
            return JSONResponse({"ok": False, "error": "녹음된 소리가 없습니다."}, 400)
        text = await transcriber.transcribe(tmp)
    except TranscribeError as e:
        return JSONResponse({"ok": False, "error": str(e)}, 502)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    return {"ok": True, "text": text}
