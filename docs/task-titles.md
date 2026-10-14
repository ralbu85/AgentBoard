# Session task titles

AgentBoard uses native agent terminal titles and short task labels in ordinary
assistant responses. It never starts a model, calls a summarization API, submits
a synthetic prompt, or executes a title-setting tool.

- Manual names take precedence.
- The initial native title is available immediately. A changed native title or
  a verified new response label updates the shared task title.
- Sending input changes workspace recency, but does not copy any prompt into
  the label. Existing v1 prompt-excerpt titles are removed on migration.
- A response may start with `작업: 모바일 터미널 표시 개선`. Only the first nonempty
  line, at most 60 characters after the prefix, is accepted. No matching label
  means keep the current title. Agents should use the label on a new task/topic,
  not for acknowledgements, retries or progress updates within the same task.
- A later changed native title remains eligible: the board cannot guarantee
  that the CLI's own title generator is current or semantically correct.

The observer reads only transcripts bound to the uniquely identified nearest
Codex/Claude process under that tmux pane: an open descriptor, or Claude's PID
registry with a matching kernel process start time. A matching transcript header
and workspace are also required. It never guesses from the latest file. Hidden
reasoning, tools, sidechains, user messages and quoted examples cannot provide
a label. Unsupported/ambiguous transcript ownership uses native titles only.
Only new user turns after observer startup qualify; old transcripts cannot
rename sessions on service restart. A newer submitted request rejects older
turns using a request digest/timestamp. Raw prompts are never stored in activity
metadata. Titles/recency persist on the hub and use versioned shared snapshots.

The observer runs every three seconds on a worker thread, reads at most 256 KiB
per eligible transcript per cycle, and keeps byte cursors for unchanged files.
There are no extra model requests. Native CLI title generation may itself cost
tokens; the board does not control that. The optional response convention adds
a short instruction and a short output line when the task changes.

## Enable the response convention

Run `backend/.venv/bin/python tools/install_task_title_instructions.py` as the
same account that runs the CLI. It adds a small marked section to Codex's user
instructions (respects AGENTS.override.md) and Claude's user CLAUDE.md, preserving
other content and making private backups. It is scoped to `AGENTBOARD_SESSION=1`,
which is set only on newly created board terminals. The instruction asks agents
to check that variable with their first *ordinary* shell command, never a
standalone title command. Outside the board the rule has no effect.

Instruction files are loaded when an agent starts. Running agents are not
restarted or sent extra input; they continue using native titles. New agents
inside old terminals do not inherit the marker automatically. Create a new
board terminal to enable the convention. A CLI may ignore the convention or
keep its transcript closed; in either case native titles continue working.
Use `--remove` on the installer to remove only its marked sections.

Remote machines need the same code and optional instruction installation. The
owning machine alone reads logs and relays the short summary; the hub persists
the chosen title. Older remote agents still supply native titles.
