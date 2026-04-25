import hashlib
import json
import mimetypes
import os
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse

from . import config
from .auth import verify
from .logger import log

router = APIRouter(prefix="/api")


def _safe_path(path: str) -> Path | None:
    """Resolve path and verify it lies inside an ALLOWED_ROOTS entry. Returns None on violation."""
    if not path:
        return None
    try:
        p = Path(os.path.expanduser(path)).resolve()
    except (OSError, ValueError):
        return None
    for root in config.ALLOWED_ROOTS:
        if p == root or p.is_relative_to(root):
            return p
    log.warning("path traversal blocked: %r → %s", path, p)
    return None


def _forbidden():
    return JSONResponse({"error": "Forbidden path"}, 403)


@router.get("/browse")
async def browse(path: str = Query("~"), _=Depends(verify)):
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    if not p.is_dir():
        return {"path": str(p), "dirs": []}
    dirs = sorted([d.name for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")])
    return {"path": str(p), "dirs": dirs}


@router.get("/files")
async def files(path: str = Query("~"), _=Depends(verify)):
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    if not p.is_dir():
        return {"path": str(p), "entries": []}
    entries = []
    try:
        for item in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if item.name.startswith("."):
                continue
            stat = item.stat()
            entries.append({
                "name": item.name,
                "type": "dir" if item.is_dir() else "file",
                "size": stat.st_size if item.is_file() else 0,
                "mtime": int(stat.st_mtime * 1000),
            })
    except PermissionError:
        pass
    return {"path": str(p), "entries": entries}


@router.get("/file")
async def read_file(path: str = Query(...), _=Depends(verify)):
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    if not p.is_file():
        return JSONResponse({"error": "Not a file"}, 404)
    if p.stat().st_size > 10 * 1024 * 1024:
        return JSONResponse({"error": "File too large"}, 413)
    try:
        content = p.read_text(errors="replace")
    except Exception as e:
        return JSONResponse({"error": str(e)}, 500)
    return {"path": str(p), "content": content, "size": p.stat().st_size}


@router.get("/file-raw")
async def read_file_raw(path: str = Query(...), _=Depends(verify)):
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    if not p.is_file():
        return JSONResponse({"error": "Not a file"}, 404)
    mime = mimetypes.guess_type(str(p))[0] or "application/octet-stream"

    def iterfile():
        with open(p, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(iterfile(), media_type=mime)


@router.post("/file")
async def write_file(req: dict, _=Depends(verify)):
    p = _safe_path(req.get("path", ""))
    if p is None:
        return _forbidden()
    content = req.get("content", "")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p)}


@router.post("/rename")
async def rename(req: dict, _=Depends(verify)):
    src = _safe_path(req.get("from", ""))
    dst = _safe_path(req.get("to", ""))
    if src is None or dst is None:
        return _forbidden()
    try:
        src.rename(dst)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.post("/delete")
async def delete(req: dict, _=Depends(verify)):
    p = _safe_path(req.get("path", ""))
    if p is None:
        return _forbidden()
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.post("/mkdir")
async def mkdir(req: dict, _=Depends(verify)):
    p = _safe_path(req.get("path", ""))
    if p is None:
        return _forbidden()
    try:
        p.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p)}


@router.post("/upload")
async def upload(request: Request, id: str = "", name: str = "", dir: str = "", _=Depends(verify)):
    target_dir = _safe_path(dir) if dir else Path.home()
    if target_dir is None:
        return _forbidden()
    target = _safe_path(str(target_dir / name))
    if target is None:
        return _forbidden()
    try:
        body = await request.body()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(target), "name": name}


# ── Notes / Annotations ──

NOTES_DIR = Path.home() / ".agentboard" / "notes"


def _notes_file(filepath: str) -> Path:
    h = hashlib.sha256(filepath.encode()).hexdigest()[:16]
    return NOTES_DIR / f"{h}.json"


@router.get("/notes")
async def get_notes(path: str = Query(...), _=Depends(verify)):
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    nf = _notes_file(str(p))
    if not nf.exists():
        return {"path": str(p), "notes": []}
    try:
        data = json.loads(nf.read_text())
        return {"path": str(p), "notes": data.get("notes", [])}
    except Exception as e:
        log.warning("notes file unreadable for %s: %s", p, e)
        return {"path": str(p), "notes": []}


@router.post("/notes")
async def save_notes(req: dict, _=Depends(verify)):
    p = _safe_path(req.get("path", ""))
    if p is None:
        return _forbidden()
    notes = req.get("notes", [])
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    nf = _notes_file(str(p))
    nf.write_text(json.dumps({"filePath": str(p), "notes": notes, "updatedAt": int(time.time())}, ensure_ascii=False))
    return {"ok": True}


@router.post("/notes/delete")
async def delete_note(req: dict, _=Depends(verify)):
    p = _safe_path(req.get("path", ""))
    if p is None:
        return _forbidden()
    start = req.get("startLine")
    end = req.get("endLine")
    nf = _notes_file(str(p))
    if not nf.exists():
        return {"ok": True}
    try:
        data = json.loads(nf.read_text())
        data["notes"] = [n for n in data.get("notes", []) if not (n.get("startLine") == start and n.get("endLine") == end)]
        nf.write_text(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        log.warning("note delete failed for %s: %s", p, e)
    return {"ok": True}
