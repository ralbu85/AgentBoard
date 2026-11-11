"""Speech to text for the input card's 🎤, run by `transcribe.py` with the
Python that has faster-whisper (AGENTBOARD_WHISPER_PYTHON), not the backend's.

Standalone on purpose: it is started with `-I`, imports nothing from the
backend and reads one JSON request per stdin line ({"path", "language"}),
answering one JSON line each ({"text"} or {"error"}). The model stays loaded
while the process lives; the backend stops it once it has been idle.
"""
import json
import os
import subprocess
import sys


def freest_gpu():
    """The GPU with the most free memory: the machine's GPUs are shared."""
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=10).stdout.split()
        free = [int(x) for x in out]
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return max(range(len(free)), key=free.__getitem__) if free else None


def main():
    protocol, sys.stdout = sys.stdout, sys.stderr   # library prints must not reach the protocol
    from faster_whisper import WhisperModel
    name = os.environ.get('AGENTBOARD_WHISPER_MODEL') or 'large-v3-turbo'
    model, gpu = None, freest_gpu()
    if gpu is not None:
        try:
            model = WhisperModel(name, device='cuda', device_index=gpu, compute_type='float16')
        except Exception as e:   # no usable CUDA: CPU is slower but works
            print(f'whisper: GPU {gpu} unavailable ({e}); using CPU', file=sys.stderr)
    if model is None:
        model = WhisperModel(name, device='cpu', compute_type='int8')
    protocol.write(json.dumps({'ready': True}) + '\n')
    protocol.flush()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            segments, _ = model.transcribe(request['path'], language=request.get('language') or None,
                                           vad_filter=True, beam_size=5)
            reply = {'text': ' '.join(s.text.strip() for s in segments if s.text.strip())}
        except Exception as e:
            reply = {'error': str(e)[:500]}
        protocol.write(json.dumps(reply, ensure_ascii=False) + '\n')
        protocol.flush()


if __name__ == '__main__':
    main()
