# Browser safety for this workspace

Browser execution must use a non-root account with Chromium/Electron sandboxing
explicitly enabled. This applies to UI tests as well as the in-app browser.
Never use `--no-sandbox`, disable namespace/seccomp sandboxes, or weaken the
host/container security policy to make a browser start. Use the dedicated worker
in `deploy/browser` or a sandbox-capable desktop environment. If neither is
available, run non-browser tests and report the missing browser verification.
Do not reopen the archived root browser profiles or launch the old temporary
research Chrome. Security evidence/backups under `/root/agentboard-security-audit-*`
contain private profile data; never print, commit or publish their contents.
Keep terminal tests isolated from live tmux sessions. Preserve unrelated changes.
