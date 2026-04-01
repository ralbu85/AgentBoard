import hashlib
import json
import mimetypes
import os
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse

from .auth import verify

router = APIRouter(prefix="/api")


@router.get("/browse")
async def browse(path: str = Query("~"), _=Depends(verify)):
    p = Path(os.path.expanduser(path)).resolve()
    if not p.is_dir():
        return {"path": str(p), "dirs": []}
    dirs = sorted([d.name for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")])
    return {"path": str(p), "dirs": dirs}


@router.get("/files")
async def files(path: str = Query("~"), _=Depends(verify)):
    p = Path(os.path.expanduser(path)).resolve()
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
    p = Path(os.path.expanduser(path)).resolve()
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
    p = Path(os.path.expanduser(path)).resolve()
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
    path = req.get("path", "")
    content = req.get("content", "")
    p = Path(os.path.expanduser(path)).resolve()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p)}


@router.post("/rename")
async def rename(req: dict, _=Depends(verify)):
    src = Path(os.path.expanduser(req.get("from", ""))).resolve()
    dst = Path(os.path.expanduser(req.get("to", ""))).resolve()
    try:
        src.rename(dst)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.post("/delete")
async def delete(req: dict, _=Depends(verify)):
    p = Path(os.path.expanduser(req.get("path", ""))).resolve()
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
    p = Path(os.path.expanduser(req.get("path", ""))).resolve()
    try:
        p.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p)}


@router.post("/upload")
async def upload(request: Request, id: str = "", name: str = "", dir: str = "", _=Depends(verify)):
    target_dir = Path(os.path.expanduser(dir)).resolve() if dir else Path.home()
    target = target_dir / name
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
    p = str(Path(os.path.expanduser(path)).resolve())
    nf = _notes_file(p)
    if not nf.exists():
        return {"path": p, "notes": []}
    try:
        data = json.loads(nf.read_text())
        return {"path": p, "notes": data.get("notes", [])}
    except Exception:
        return {"path": p, "notes": []}


@router.post("/notes")
async def save_notes(req: dict, _=Depends(verify)):
    filepath = str(Path(os.path.expanduser(req.get("path", ""))).resolve())
    notes = req.get("notes", [])
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    nf = _notes_file(filepath)
    nf.write_text(json.dumps({"filePath": filepath, "notes": notes, "updatedAt": int(time.time())}, ensure_ascii=False))
    return {"ok": True}


@router.post("/notes/delete")
async def delete_note(req: dict, _=Depends(verify)):
    filepath = str(Path(os.path.expanduser(req.get("path", ""))).resolve())
    start = req.get("startLine")
    end = req.get("endLine")
    nf = _notes_file(filepath)
    if not nf.exists():
        return {"ok": True}
    try:
        data = json.loads(nf.read_text())
        data["notes"] = [n for n in data.get("notes", []) if not (n.get("startLine") == start and n.get("endLine") == end)]
        nf.write_text(json.dumps(data, ensure_ascii=False))
    except Exception:
        pass
    return {"ok": True}
