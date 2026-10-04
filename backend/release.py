"""Back up, atomically publish and verify frontend assets; never kill by port."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from . import config


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate(stage: Path):
    index = (stage/'index.html').read_text()
    required = sorted(set(re.findall(r'(?:src|href)="/?(assets/[^"?]+)', index)))
    if not required:
        raise ValueError('Build has no referenced assets')
    if any(path.is_symlink() for path in stage.rglob('*')):
        raise ValueError('Build must not contain symlinks')
    for item in required:
        file = (stage/item).resolve()
        if not file.is_relative_to(stage.resolve()) or not file.is_file():
            raise ValueError('Build references missing/outside assets')
    return required


def atomic_copy(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=target.name+'.', suffix='.next', dir=target.parent)
    os.close(fd);temp = Path(name)
    try:
        shutil.copyfile(source, temp);temp.chmod(0o644);temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)


def publish(stage: Path, live: Path, releases: Path, revision: str):
    required = validate(stage)
    releases.mkdir(mode=0o700, parents=True, exist_ok=True);releases.chmod(0o700)
    release = releases/datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    release.mkdir(mode=0o700)
    if live.exists():shutil.copytree(live, release/'previous-dist')
    live.mkdir(parents=True, exist_ok=True)
    # Hashed assets coexist: old clients can still load their own lazy chunks.
    for path in stage.rglob('*'):
        if path.is_file() and path.name != 'index.html':
            atomic_copy(path, live/path.relative_to(stage))
    atomic_copy(stage/'index.html', live/'index.html')
    receipt = {'release': release.name, 'revision': revision, 'indexSha256': digest(live/'index.html'),
               'assets': {item: digest(live/item) for item in required}, 'verified': False}
    target = release/'receipt.json'
    target.write_text(json.dumps(receipt, indent=2)+'\n');target.chmod(0o600)
    return release, receipt


def get_json(path):
    request = Request(f'http://127.0.0.1:{config.PORT}'+path, headers={'Cookie':'token='+config.AUTH_TOKEN})
    with urlopen(request, timeout=10) as response:return json.load(response)


def restart_ready():
    notebooks=get_json('/api/notebooks')['sessions']
    active=any(item.get('kernel',True) or item.get('dirty',True) or item.get('state')!='stopped' for item in notebooks)
    if active or get_json('/api/browser/tabs')['tabs']:
        raise RuntimeError('Active notebook/browser sessions; stop them explicitly before backend restart')
    result = subprocess.run(['supervisorctl','status','agentboard'], capture_output=True, text=True)
    if result.returncode or 'RUNNING' not in result.stdout:
        raise RuntimeError('Named agentboard service is not running; no process will be killed')


def panes():
    result = subprocess.run(['tmux','list-panes','-a','-F','#{session_id}:#{pane_id}:#{pane_pid}'],capture_output=True,text=True)
    if result.returncode:raise RuntimeError('Cannot record terminal identities; restart postponed')
    return set(result.stdout.splitlines())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage',type=Path);parser.add_argument('--restart',action='store_true')
    args=parser.parse_args();validate(args.stage)
    identity=panes() if args.restart else set()
    if args.restart:restart_ready()
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=config.PROJECT_ROOT,text=True).strip()
    dirty=subprocess.check_output(['git','status','--porcelain'],cwd=config.PROJECT_ROOT,text=True).strip()
    if dirty:raise RuntimeError('Commit reviewed source before publishing a versioned release')
    release, receipt=publish(args.stage,config.PROJECT_ROOT/'frontend/dist',config.STATE_DIR/'.releases',revision)
    if args.restart:subprocess.run(['supervisorctl','restart','agentboard'],check=True,capture_output=True)
    last_error=None
    for _ in range(20):
        try:
            get_json('/api/health')
            for name, expected in [('index.html',receipt['indexSha256']),*receipt['assets'].items()]:
                with urlopen(f'http://127.0.0.1:{config.PORT}/'+('' if name=='index.html' else name),timeout=10) as response:
                    actual=hashlib.sha256(response.read()).hexdigest()
                if actual!=expected:raise RuntimeError('Served asset differs from staged build')
            last_error=None;break
        except Exception as error:
            last_error=error;time.sleep(.25)
    if last_error:raise RuntimeError('Release verification failed; protected previous-dist backup is available')
    if args.restart and not identity<=panes():raise RuntimeError('Some previous terminal identities are missing; inspect running service')
    receipt.update(verified=True,retainedTerminalPanes=len(identity))
    (release/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'release':release.name,'revision':revision[:12],'verified':True,'retainedTerminalPanes':len(identity)}))


if __name__=='__main__':main()
