"""Read-only files next to a previewed HTML page (its images, CSS, JS).

The preview iframe is sandboxed with an opaque origin, so the session cookie
does not reach its requests. A signed, expiring token in the URL names the one
folder the page may read instead; the token, not the cookie, is the grant."""
import base64
import hashlib
import hmac
import mimetypes
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, JSONResponse

from . import config
from .auth import verify
from .routes_file import _safe_path

router = APIRouter(prefix='/api')

TTL = 24 * 3600
# A page's `../site_libs/…` reaches above its own folder: grant the project it belongs to.
MARKERS = ('.git', '_quarto.yml', '_quarto.yaml')
HEADERS = {
    'Access-Control-Allow-Origin': '*',                  # module scripts and fonts load with CORS from the opaque origin
    'Content-Security-Policy': 'sandbox allow-scripts',  # opened as a page, a served HTML/SVG still can't act as the app
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _mac(body: str) -> str:
    key = hmac.new(config.AUTH_TOKEN.encode(), b'html-preview', hashlib.sha256).digest()
    return _b64(hmac.new(key, body.encode(), hashlib.sha256).digest())


def sign(root: Path, expires: int) -> str:
    body = _b64(f'{expires}:{root}'.encode())
    return f'{body}.{_mac(body)}'


def granted(token: str) -> Path | None:
    body, _, mac = token.partition('.')
    if not body or not hmac.compare_digest(mac, _mac(body)):
        return None
    try:
        expires, _, root = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)).decode().partition(':')
        return Path(root) if int(expires) > time.time() else None
    except ValueError:
        return None


def _allowed(folder: Path) -> bool:
    return any(folder == r or folder.is_relative_to(r) for r in config.ALLOWED_ROOTS)


def project_of(file: Path) -> Path:
    for folder in [file.parent, *file.parent.parents]:
        if not _allowed(folder):
            break
        if any((folder / m).exists() for m in MARKERS):
            return folder
    return file.parent


@router.get('/preview-base')
async def preview_base(path: str = Query(..., max_length=4096), _=Depends(verify)):
    file = _safe_path(path)
    if file is None or not file.is_file():
        return JSONResponse({'error': 'Not a file'}, 404)
    root = project_of(file)
    rel = file.parent.relative_to(root).as_posix()
    return {'prefix': f'/api/preview/{sign(root, int(time.time()) + TTL)}/', 'dir': '' if rel == '.' else quote(rel) + '/',
            'root': str(root), 'expires': TTL}


@router.get('/preview/{token}/{rest:path}')
async def preview_file(token: str, rest: str):
    root = granted(token)
    if root is None:
        return JSONResponse({'error': '미리보기 주소가 만료되었습니다. 새로고침하세요.'}, 403, headers=HEADERS)
    # Dot-files (.env, .git) stay out even inside the project.
    parts = Path(rest).parts
    file = None if not parts or any(p.startswith('.') for p in parts) else _safe_path(str(root / rest))
    if file is None or not file.is_relative_to(root.resolve()) or not file.is_file():
        return JSONResponse({'error': 'Not found'}, 404, headers=HEADERS)
    return FileResponse(file, media_type=mimetypes.guess_type(file.name)[0] or 'application/octet-stream', headers=HEADERS)

