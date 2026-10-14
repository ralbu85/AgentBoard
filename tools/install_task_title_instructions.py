"""Opt-in, reversible response convention. Never modifies agent security settings."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import tempfile
import time

START = '<!-- agentboard-task-titles:start -->'
END = '<!-- agentboard-task-titles:end -->'
BLOCK = '''
## AgentBoard task titles (scoped)

With your first ordinary shell command, also inspect `AGENTBOARD_SESSION`; do
not make a separate tool call just for this check. Only when its value is `1`:
when starting a new task/topic, begin an ordinary visible assistant response
with `작업: <short semantic task summary>` (2–60 characters, preferably Korean).
Summarize the goal; do not quote the prompt or expose sensitive values. Keep the
same task for acknowledgements, retries and continuation; omit the label then.
Do not call a model, run a command or edit a file just to set a title. Otherwise
this section has no effect. Follow higher-priority response-format requirements.
'''


def install(path, remove=False):
    if path.is_symlink():
        raise ValueError('Refusing to replace an instruction symlink')
    previous = path.read_text() if path.exists() else ''
    if START in previous or END in previous:
        if previous.count(START) != 1 or previous.count(END) != 1 or previous.index(END) < previous.index(START):
            raise ValueError('Malformed task title markers; instructions left unchanged')
        start, end = previous.index(START), previous.index(END) + len(END)
        # Keep all unrelated bytes; the block owns only its own markers/text.
        replacement = '' if remove else START + BLOCK + END
        updated = previous[:start] + replacement + previous[end:]
    elif remove:
        return False
    else:
        updated = previous + ('\n' if previous and not previous.endswith('\n') else '') + '\n' + START + BLOCK + END + '\n'
    if updated == previous:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(path.name + '.agentboard-backup-' + str(time.time_ns()))
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(previous)
    fd, name = tempfile.mkstemp(prefix='.agentboard-instructions-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            os.chmod(name, path.stat().st_mode & 0o777)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    codex = Path(os.environ.get('CODEX_HOME') or Path.home()/'.codex')
    claude = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home()/'.claude')
    instruction = codex/'AGENTS.override.md'
    if not instruction.exists() or not instruction.read_text().strip():
        instruction = codex/'AGENTS.md'
    for path in [instruction, claude/'CLAUDE.md']:
        changed = install(path, args.remove)
        print(f'{path}: {"updated" if changed else "unchanged"}')


if __name__ == '__main__':
    main()
