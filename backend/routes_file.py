import asyncio
import hashlib
import json
import mimetypes
import os
import shutil
import time
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse

from . import config
from .auth import verify
from .logger import log
from .models import (
    FileWriteRequest, RenameRequest, DeleteRequest, MkdirRequest,
    NotesSaveRequest, NoteDeleteRequest,
)

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
        return JSONResponse({"ok": False, "error": "폴더가 존재하지 않습니다."}, 404)
    dirs = sorted([d.name for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")])
    return {"path": str(p), "dirs": dirs, "isDir": True}


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
        raw = p.read_bytes()
        content = raw.decode("utf-8", errors="replace")
    except Exception as e:
        return JSONResponse({"error": str(e)}, 500)
    return {"path": str(p), "content": content, "size": len(raw), "version": hashlib.sha256(raw).hexdigest()}


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


_DIFF_MAX = 800_000  # cap diff payload so a huge change set doesn't flood the client


async def _git(args: list[str], cwd: str) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", cwd, *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        return proc.returncode, out.decode("utf-8", errors="replace")
    except Exception as e:
        log.debug("git %s failed: %s", args, e)
        return 1, ""


@router.get("/git/diff")
async def git_diff(path: str = Query(...), _=Depends(verify)):
    """Uncommitted changes (working tree vs HEAD) for a folder or a single file
    — shows what an agent has changed. Returns empty if the path isn't in a repo."""
    p = _safe_path(path)
    if p is None:
        return _forbidden()
    d = str(p if p.is_dir() else p.parent)
    rc, top = await _git(["rev-parse", "--show-toplevel"], d)
    if rc != 0:
        return {"ok": True, "isRepo": False, "diff": "", "files": []}
    if p.is_dir():
        _, diff = await _git(["diff", "HEAD"], d)
        _, status = await _git(["status", "--porcelain"], d)
        files = [ln[3:] for ln in status.splitlines() if ln.strip()]
    else:
        _, diff = await _git(["diff", "HEAD", "--", str(p)], d)
        files = []
    truncated = len(diff) > _DIFF_MAX
    return {"ok": True, "isRepo": True, "diff": diff[:_DIFF_MAX], "truncated": truncated,
            "files": files, "root": top.strip()}


@router.post("/file")
async def write_file(req: FileWriteRequest, _=Depends(verify)):
    p = _safe_path(req.path)
    if p is None:
        return _forbidden()
    tmp = None
    try:
        if req.expectedVersion is not None:
            current = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else ''
            if current != req.expectedVersion:
                return JSONResponse({"ok": False, "error": "파일이 외부에서 변경되었습니다. 변경 내용을 보관한 뒤 새로고침하여 비교해 주세요."}, 409)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: a crash/concurrent write mid-way would otherwise leave a
        # truncated/corrupt file. Write to a sibling temp, then os.replace().
        with tempfile.NamedTemporaryFile(dir=p.parent, prefix=f".{p.name}.tmp-", delete=False) as f:
            tmp = Path(f.name)
            f.write(req.content.encode('utf-8'))
        if p.exists():
            tmp.chmod(p.stat().st_mode & 0o777)
        os.replace(tmp, p)
    except Exception as e:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p), "version": hashlib.sha256(req.content.encode("utf-8")).hexdigest()}


@router.post("/rename")
async def rename(req: RenameRequest, _=Depends(verify)):
    src = _safe_path(req.from_path)
    dst = _safe_path(req.to_path)
    if src is None or dst is None:
        return _forbidden()
    try:
        src.rename(dst)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.post("/delete")
async def delete(req: DeleteRequest, _=Depends(verify)):
    p = _safe_path(req.path)
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
async def mkdir(req: MkdirRequest, _=Depends(verify)):
    p = _safe_path(req.path)
    if p is None:
        return _forbidden()
    try:
        p.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(p)}


@router.post("/upload")
async def upload(
    request: Request,
    id: str = Query("", max_length=128),
    name: str = Query("", max_length=255),
    dir: str = Query("", max_length=4096),
    _=Depends(verify),
):
    target_dir = _safe_path(dir) if dir else Path.home()
    if target_dir is None:
        return _forbidden()
    target = _safe_path(str(target_dir / name))
    if target is None:
        return _forbidden()
    if not name or Path(name).name != name or name in ('.', '..'):
        return JSONResponse({"ok": False, "error": "Invalid filename"}, 400)
    tmp = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # Stream into a temporary file, keeping partial uploads out of the tree.
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.upload-', delete=False) as f:
            tmp = Path(f.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 100 * 1024 * 1024:
                    return JSONResponse({"ok": False, "error": "파일당 최대 100 MiB까지 업로드할 수 있습니다."}, 413)
                f.write(chunk)
        # Atomic creation without silently replacing existing user files.
        os.link(tmp, target)
    except FileExistsError:
        return JSONResponse({"ok": False, "error": "같은 이름의 파일이 있습니다. 이름을 변경한 뒤 다시 업로드하세요."}, 409)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
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
async def save_notes(req: NotesSaveRequest, _=Depends(verify)):
    p = _safe_path(req.path)
    if p is None:
        return _forbidden()
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    nf = _notes_file(str(p))
    nf.write_text(json.dumps({"filePath": str(p), "notes": req.notes, "updatedAt": int(time.time())}, ensure_ascii=False))
    return {"ok": True}


@router.post("/notes/delete")
async def delete_note(req: NoteDeleteRequest, _=Depends(verify)):
    p = _safe_path(req.path)
    if p is None:
        return _forbidden()
    start = req.startLine
    end = req.endLine
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
