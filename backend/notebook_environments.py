"""Discover environments without executing project scripts or interpreters."""
import hashlib
import os
import shutil
from pathlib import Path
from jupyter_client.kernelspec import KernelSpecManager
from .routes_file import _safe_path


def discover(folder, default_python):
    result = []
    seen = set()
    def add(python, name, source, key=None):
        if not python:
            return
        path = Path(python).expanduser().absolute()
        # Preserve the venv's executable path (resolving its symlink loses the venv).
        if key != 'default' and (not path.is_file() or not os.access(path, os.X_OK)):
            return
        identity = str(path)
        if identity in seen and not (key or '').startswith('kernelspec:'):
            return
        seen.add(identity)
        result.append({'id': key or hashlib.sha256(identity.encode()).hexdigest(),
                       'name': name, 'python': identity, 'source': source})
    add(default_python, 'Python · 서버 기본', '기본 환경', 'default')
    folder = Path(folder)
    for parent in [folder, *folder.parents]:
        if _safe_path(str(parent)) is None:
            break
        for name in ('.venv', 'venv', 'env', '.conda'):
            add(parent/name/'bin'/'python', f'{name} · {parent.name}', '프로젝트 환경')
        if parent == Path.home():
            break
    for root in (Path.home()/'miniconda3'/'envs', Path.home()/'anaconda3'/'envs', Path('/opt/conda/envs')):
        if root.is_dir():
            for env in sorted(root.iterdir())[:64]:
                add(env/'bin'/'python', env.name, 'Conda 환경')
    for key, value in KernelSpecManager().get_all_specs().items():
        spec = value['spec']
        argv = spec.get('argv', [])
        # Only Python ipykernel launchers are supported, never arbitrary wrappers.
        if str(spec.get('language', '')).lower() != 'python' or len(argv) < 3 or argv[1:3] != ['-m', 'ipykernel_launcher']:
            continue
        executable = argv[0] if os.path.isabs(argv[0]) else shutil.which(argv[0])
        add(executable, spec.get('display_name', key), '등록된 Jupyter 커널', 'kernelspec:'+key)
    return result
