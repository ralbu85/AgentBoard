# Screenshot demo rig

Staged agent transcripts + a Playwright shoot script used to produce
`docs/screenshots/`. Run an ISOLATED AgentBoard instance (own port, own
`AGENTBOARD_STATE_DIR`, and critically its own tmux server via a short
`TMUX_TMPDIR` — unix socket paths cap at ~104 chars) so no real session data
appears in the shots, spawn `agent-*.sh` via the API, then `node shoot.js`.
