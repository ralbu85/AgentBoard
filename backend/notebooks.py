"""Local Python notebook documents, private recovery drafts and owned kernels."""
import asyncio
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from queue import Empty

import nbformat
from fastapi import HTTPException
from jupyter_client import AsyncKernelManager

from . import config
from .routes_file import _safe_path

STATE_DIR = config.STATE_DIR / '.notebook-state'
PYTHON = os.getenv('AGENTBOARD_NOTEBOOK_PYTHON') or shutil.which('python3') or sys.executable
MAX_KERNELS = max(1, min(16, int(os.getenv('AGENTBOARD_NOTEBOOK_KERNELS', '4'))))
IDLE_SECONDS = max(60, int(os.getenv('AGENTBOARD_NOTEBOOK_IDLE_SECONDS', '1800')))
MAX_DOCUMENT = 10 * 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
MAX_DOCUMENTS = 32


def checked_path(value):
    path = _safe_path(value)
    if path is None:
        raise HTTPException(403, '허용되지 않은 노트북 경로입니다.')
    if path.suffix.lower() != '.ipynb' or not path.is_file():
        raise HTTPException(400, '존재하는 .ipynb 파일을 선택하세요.')
    return path


def parse(content):
    if len(content.encode()) > MAX_DOCUMENT:
        raise HTTPException(413, '노트북은 10MB까지 지원합니다.')
    try:
        data = json.loads(content)
        if data.get('nbformat') != 4:
            raise ValueError('nbformat 4 required')
        nbformat.validate(data)
        if len(data['cells']) > 2000:
            raise ValueError('too many cells')
        if len(encoded(data).encode()) > MAX_DOCUMENT:
            raise HTTPException(413, '정규화된 노트북이 10MB를 초과했습니다.')
        return data
    except (ValueError, TypeError, AttributeError, nbformat.ValidationError) as exc:
        raise HTTPException(400, '유효한 nbformat 4 노트북이 아닙니다.') from exc


def encoded(notebook):
    return json.dumps(notebook, ensure_ascii=False, indent=1) + '\n'


def version(raw):
    return hashlib.sha256(raw).hexdigest()


def atomic_write(path, raw, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.'+path.name+'-', delete=False) as file:
            temp = Path(file.name)
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        temp.chmod(mode)
        os.replace(temp, path)
    finally:
        if temp and temp.exists():
            temp.unlink()


class Document:
    def __init__(self, path):
        self.path = path
        self.id = version(str(path).encode())
        raw = path.read_bytes()
        self.notebook = parse(raw.decode('utf-8'))
        self.file_version = version(raw)
        self.dirty = False
        self.revision = time.time_ns() // 1000
        self.state = 'stopped'
        self.environment = 'default'
        self.python = PYTHON
        self.kernel_name = 'Python · 서버 기본'
        self.error = ''
        self.active_cell = None
        self.km = None
        self.client = None
        self.task = None
        self.stop_requested = False
        self.last_activity = time.monotonic()
        self.last_checkpoint = 0
        self.lock = asyncio.Lock()
        self.displays = {}
        checkpoint = STATE_DIR / (self.id+'.json')
        if checkpoint.exists():
            try:
                saved = json.loads(checkpoint.read_text())
                if saved.get('path') == str(path):
                    self.environment = saved.get('environment', 'default')
                if saved['path'] == str(path) and saved['dirty']:
                    self.notebook = parse(encoded(saved['notebook']))
                    self.file_version = saved['version']
                    self.dirty = True
                    self.error = '저장 전 편집·출력을 복구했습니다. 커널 변수는 새로 실행해야 합니다.'
            except (ValueError, KeyError, OSError, HTTPException):
                pass

        if self.environment != 'default':
            option = next((item for item in self.environments() if item['id'] == self.environment), None)
            self.kernel_name = option['name'] if option else '선택한 환경을 찾을 수 없음'
            self.python = option['python'] if option else ''

    @property
    def busy(self):
        return self.state in ('starting', 'running', 'interrupting', 'stopping')

    def snapshot(self, include_content=True):
        snapshot = {'id': self.id, 'path': str(self.path),
                'version': self.file_version, 'revision': self.revision, 'dirty': self.dirty,
                'state': self.state, 'cell': self.active_cell, 'error': self.error,
                'python': self.python, 'environment': self.environment, 'kernelName': self.kernel_name, 'kernel': bool(self.km)}
        if include_content:
            snapshot['content'] = encoded(self.notebook)
        return snapshot

    def touch(self, checkpoint=False):
        self.revision += 1
        self.last_activity = time.monotonic()
        if checkpoint or self.last_activity-self.last_checkpoint >= 1:
            self.checkpoint()

    def checkpoint(self):
        atomic_write(STATE_DIR/(self.id+'.json'), json.dumps({
            'path': str(self.path), 'notebook': self.notebook,
            'version': self.file_version, 'dirty': self.dirty, 'environment': self.environment,
        }, ensure_ascii=False).encode())
        self.last_checkpoint = time.monotonic()

    def check_revision(self, revision):
        if revision != self.revision:
            raise HTTPException(409, '다른 화면에서 노트북 상태가 변경되었습니다. 서버 상태를 확인하세요.')

    def update(self, content, revision):
        self.check_revision(revision)
        if self.busy:
            raise HTTPException(409, '실행·중단이 끝난 뒤 편집하거나 저장하세요.')
        notebook = parse(content)
        if notebook != self.notebook:
            self.notebook = notebook
            self.displays.clear()
            self.dirty = True
            self.touch(checkpoint=True)

    def save(self, revision):
        self.check_revision(revision)
        if self.busy:
            raise HTTPException(409, '실행·중단이 끝난 뒤 결과를 저장하세요.')
        if checked_path(str(self.path)) != self.path:
            raise HTTPException(409, '파일 경로가 변경되었습니다.')
        if version(self.path.read_bytes()) != self.file_version:
            raise HTTPException(409, '파일이 외부에서 변경되어 저장하지 않았습니다. 다운로드로 현재 내용을 보관한 뒤 원본과 비교하세요.')
        raw = encoded(self.notebook).encode()
        if len(raw) > MAX_DOCUMENT:
            raise HTTPException(413, '출력을 포함한 노트북이 10MB를 초과했습니다.')
        atomic_write(self.path, raw, self.path.stat().st_mode & 0o777)
        self.file_version = version(raw)
        self.dirty = False
        self.touch(checkpoint=True)

    def environments(self):
        from .notebook_environments import discover
        return discover(self.path.parent, PYTHON)

    def select_environment(self, key):
        if self.km or self.busy:
            raise HTTPException(409, '커널을 종료한 뒤 환경을 변경하세요. 코드와 출력은 유지됩니다.')
        option = next((item for item in self.environments() if item['id'] == key), None)
        if not option:
            raise HTTPException(404, '이 실행 폴더에서 찾을 수 없는 Python 환경입니다. 목록을 새로고침하세요.')
        self.environment = option['id']
        self.python = option['python']
        self.kernel_name = option['name']
        self.error = ''
        self.touch(checkpoint=True)

    async def start(self):
        if self.km:
            if await self.km.is_alive():
                return
            await self.shutdown()
        metadata = self.notebook.get('metadata', {})
        language = metadata.get('kernelspec', {}).get('language') or metadata.get('language_info', {}).get('name', 'python')
        if str(language).lower() not in ('python', 'python3'):
            raise HTTPException(400, '현재는 이 서버의 Python 노트북만 실행할 수 있습니다.')
        self.select_environment(self.environment)
        self.state = 'starting'
        self.error = ''
        self.touch()
        km = AsyncKernelManager(kernel_name='python3', autorestart=False)
        # Never execute a kernelspec supplied by the notebook or browser.
        km.kernel_spec.argv = [self.python, '-m', 'ipykernel_launcher', '-f', '{connection_file}']
        km.kernel_spec.env = {}
        self.km = km
        try:
            await km.start_kernel(cwd=str(self.path.parent))
            self.client = km.client()
            self.client.start_channels()
            await self.client.wait_for_ready(timeout=20)
            self.state = 'idle'
            self.touch()
        except BaseException as exc:
            await self.shutdown()
            self.error = f'선택한 환경({self.kernel_name})에 연결하지 못했습니다. {self.python}의 ipykernel 설치와 실행 권한을 확인하세요.'
            self.touch()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise HTTPException(503, self.error) from exc

    def clear_outputs(self, index):
        self.notebook['cells'][index]['outputs'] = []
        self.displays = {key: [(ci, oi) for ci, oi in targets if ci != index]
                         for key, targets in self.displays.items()}

    def validate_indices(self, indices):
        for index in indices:
            if type(index) is not int or not 0 <= index < len(self.notebook['cells']) or self.notebook['cells'][index]['cell_type'] != 'code':
                raise HTTPException(400, '실행할 코드 셀을 선택하세요.')

    def schedule(self, indices):
        if self.busy:
            raise HTTPException(409, '이미 실행 중입니다.')
        if not self.km:
            raise HTTPException(409, '커널을 먼저 연결하세요.')
        self.validate_indices(indices)
        self.stop_requested = False
        self.state = 'running'
        self.error = ''
        self.touch(checkpoint=True)
        self.task = asyncio.create_task(self.execute(indices))

    async def execute(self, indices):
        try:
            for index in indices:
                if self.stop_requested:
                    break
                cell = self.notebook['cells'][index]
                self.active_cell = index
                self.clear_outputs(index)
                cell['execution_count'] = None
                self.dirty = True
                self.touch()
                code = cell.get('source', '')
                if isinstance(code, list):
                    code = ''.join(code)
                message_id = self.client.execute(code, allow_stdin=False, stop_on_error=True)
                output_size = 0
                output_budget = min(MAX_OUTPUT, max(0, MAX_DOCUMENT-len(encoded(self.notebook).encode())-1024))
                truncated = False
                clear_next = False
                failed = False
                while True:
                    try:
                        message = await self.client.get_iopub_msg(timeout=1)
                    except Empty:
                        if not self.km or not await self.km.is_alive():
                            raise RuntimeError('커널이 종료되었습니다.')
                        continue
                    if message.get('parent_header', {}).get('msg_id') != message_id:
                        continue
                    kind, content = message['msg_type'], message['content']
                    if kind == 'status' and content.get('execution_state') == 'idle':
                        break
                    if kind == 'execute_input':
                        cell['execution_count'] = content['execution_count']
                    elif kind == 'clear_output':
                        if content.get('wait'):
                            clear_next = True
                        else:
                            self.clear_outputs(index)
                    elif kind in ('stream', 'display_data', 'execute_result', 'error', 'update_display_data'):
                        failed |= kind == 'error'
                        if clear_next:
                            self.clear_outputs(index)
                            clear_next = False
                        size = len(json.dumps(content).encode())
                        if output_size+size > output_budget or len(cell['outputs']) >= 1000:
                            if not truncated:
                                cell['outputs'].append({'output_type': 'stream', 'name': 'stderr', 'text': '\n[표시·저장할 셀 출력 한도에 도달했습니다. 추가 출력은 생략됩니다.]\n'})
                                truncated = True
                            self.touch()
                            continue
                        output_size += size
                        if kind == 'stream':
                            output = {'output_type': kind, 'name': content['name'], 'text': content['text']}
                            if cell['outputs'] and cell['outputs'][-1].get('output_type') == 'stream' and cell['outputs'][-1]['name'] == output['name']:
                                cell['outputs'][-1]['text'] += output['text']
                            else:
                                cell['outputs'].append(output)
                        elif kind == 'error':
                            cell['outputs'].append({key: content[key] for key in ('ename', 'evalue', 'traceback')} | {'output_type': 'error'})
                        else:
                            display_id = content.get('transient', {}).get('display_id')
                            output = {'output_type': 'display_data' if kind == 'update_display_data' else kind, 'data': content['data'], 'metadata': content.get('metadata', {})}
                            if kind == 'execute_result':
                                output['execution_count'] = content['execution_count']
                                cell['execution_count'] = content['execution_count']
                            if kind == 'update_display_data':
                                for ci, oi in self.displays.get(display_id, []):
                                    target = self.notebook['cells'][ci]['outputs']
                                    if oi < len(target):
                                        if len(encoded(self.notebook).encode()) + size + 1024 > MAX_DOCUMENT:
                                            break
                                        target[oi]['data'] = copy.deepcopy(output['data'])
                                        target[oi]['metadata'] = copy.deepcopy(output['metadata'])
                            else:
                                cell['outputs'].append(output)
                                if display_id:
                                    self.displays.setdefault(display_id, []).append((index, len(cell['outputs'])-1))
                    self.touch()
                # Drain the corresponding shell reply as well as IOPub; otherwise
                # every execution leaves a reply queued in the long-lived client.
                while True:
                    reply = await self.client.get_shell_msg(timeout=10)
                    if reply.get('parent_header', {}).get('msg_id') == message_id:
                        failed |= reply['content'].get('status') == 'error'
                        break
                self.checkpoint()
                if failed:
                    self.error = '' if self.stop_requested else '셀에서 오류가 발생해 실행을 멈췄습니다. 아래 출력을 확인하세요.'
                    break
        except asyncio.CancelledError:
            self.error = '실행이 중단되었습니다.'
        except Exception as exc:
            self.error = str(exc)[:300]
            if self.km and not await self.km.is_alive():
                await self.shutdown()
        finally:
            self.active_cell = None
            self.state = 'idle' if self.km else 'stopped'
            self.touch(checkpoint=True)

    async def interrupt(self):
        if not self.task or self.task.done() or not self.km:
            return
        self.stop_requested = True
        self.state = 'interrupting'
        self.touch()
        await self.km.interrupt_kernel()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), 5)
        except asyncio.TimeoutError:
            await self.shutdown()
            self.error = '중단 요청에 응답하지 않아 커널을 종료했습니다. 다시 연결해 주세요.'
            self.touch(checkpoint=True)

    async def shutdown(self):
        self.state = 'stopping'
        if self.task and self.task is not asyncio.current_task() and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.km:
            try:
                await self.km.shutdown_kernel(now=True)
            finally:
                if self.client:
                    self.client.stop_channels()
                self.km = self.client = None
        self.displays.clear()
        self.state = 'stopped'
        self.active_cell = None
        self.touch(checkpoint=True)


class NotebookManager:
    def __init__(self):
        self.documents = {}
        self.kernel_lock = asyncio.Lock()

    def open(self, path):
        path = checked_path(path)
        key = version(str(path).encode())
        if key not in self.documents:
            if path.stat().st_size > MAX_DOCUMENT:
                raise HTTPException(413, '노트북은 10MB까지 지원합니다.')
            if len(self.documents) >= MAX_DOCUMENTS:
                inactive = [d for d in self.documents.values() if not d.km and not d.busy]
                if not inactive:
                    raise HTTPException(409, '열린 노트북이 너무 많습니다. 사용하지 않는 커널을 종료하세요.')
                oldest = min(inactive, key=lambda d: d.last_activity)
                oldest.checkpoint()
                del self.documents[oldest.id]
            self.documents[key] = Document(path)
        return self.documents[key]

    def get(self, key):
        document = self.documents.get(key)
        if not document:
            raise HTTPException(404, '노트북 연결을 다시 열어 주세요.')
        if _safe_path(str(document.path)) != document.path:
            raise HTTPException(409, '노트북 경로가 변경되었습니다.')
        return document

    async def start(self, document):
        async with self.kernel_lock:
            if not document.km and sum(bool(d.km) for d in self.documents.values()) >= MAX_KERNELS:
                raise HTTPException(409, f'커널은 최대 {MAX_KERNELS}개입니다. 실행 목록에서 사용하지 않는 커널을 종료하세요.')
            await document.start()

    async def reap(self):
        while True:
            await asyncio.sleep(60)
            for document in list(self.documents.values()):
                if document.km and not document.busy and time.monotonic()-document.last_activity > IDLE_SECONDS:
                    async with document.lock:
                        if not document.busy:
                            await document.shutdown()
                            document.error = '오래 사용하지 않은 커널을 종료했습니다. 출력은 보존되어 있습니다.'
                            document.touch()

    async def shutdown(self):
        await asyncio.gather(*(d.shutdown() for d in self.documents.values()), return_exceptions=True)


manager = NotebookManager()
