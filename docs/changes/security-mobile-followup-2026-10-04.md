# Security and mobile follow-up — 2026-10-04

## Delivered implementation

- Mobile selection maps visual wraps to original text. Long commands/URLs copy
  without inserted wrapping newlines, and HTTP(S) links work across display rows.
- The toolbar's **대화** view reads original local Claude/Codex messages with
  device-width layout. Exact process ownership is required for automatic binding;
  otherwise selection is explicit. It never chooses the latest file in a folder.
  Reasoning/system/tool payloads are excluded. Images and other automatic remote
  loads are stripped. Byte cursors support older pages and prevent duplicate
  messages during appends; stale responses cannot cross session boundaries.
- Login results, API route templates, WebSocket connections and app-managed
  browser destinations are logged privately. Bodies, cookies, queries, transcript
  contents, command text and credentials are omitted. Client addresses use a
  keyed correlation label. Rotation bounds storage to roughly 25 MB.
- Four older demo scripts and the paper example now follow the same browser
  launch guard. The root hub Docker image no longer installs Chromium.
- Content-hashed frontend assets avoid mixed-version lazy chunks during release.
  Deployment backs up the old frontend, checks active notebook/browser work,
  restarts only the named service and verifies all preexisting terminal PIDs.

## Credential and evidence handling

Six credential/configuration locations were reviewed without printing values;
the protected inventory is `/root/agentboard-finish-20261004/credential-review.json`.
Existing private credential files are owner-only. World-write was removed from
one existing authentication/proxy log. No credentials were revoked: the preceding
scope called for reviewing the rotation range, and revoking provider credentials
without reconnecting dependent agents would interrupt ongoing access.

The new app audit directory is `$AGENTBOARD_STATE_DIR/.security-audit` (0700,
files 0600), configurable with `AGENTBOARD_AUDIT_DIR`. It does not reconstruct
historical traffic, capture arbitrary shell/host egress, identify users behind
untrusted proxies, or protect against a compromised root account. Host/network
logs and provider revocation remain separate incident-response actions. The
October 2 evidence review did not prove that exfiltration never occurred.

## Verification and external requirements

Use unit tests and `npm --prefix frontend run build` for local verification.
The synthetic browser suite is `npm --prefix frontend run test:browser` and has
a non-root CI job. A phone viewport in Chromium is not a physical iPhone test.

Local results after dependency updates: frontend 165 passed; backend 166 passed
and 1 skipped; desktop policy/unit tests 4 passed; TypeScript/Vite build passed.
The non-root runner discovered 8 browser cases but did not execute a browser.
`npm audit` reports zero known findings for the frontend dependency tree and
desktop production dependencies. Ten frontend findings were removed with updates
inside existing major-version ranges. This is not a guarantee against unknown
vulnerabilities or a complete operating-system/Python dependency assessment.

The repository's 244 candidate source files were checked against known configured
credential values without emitting those values; there were zero matches. The
source tree and committed data are distinct from private evidence and profiles.

The current server still rejects non-root namespace creation and cannot reach a
Docker daemon. No desktop client is connected. `python -m backend.browser_check`
returns a blocked result before launching a local root browser. An isolated
worker is prepared under `deploy/browser`, but has not been deployed/verified on
a supported host. No restrictions were relaxed to complete these checks.

Physical iPhone checks still pending: long-press selection handles and native Copy,
scrolling during streaming/selection, keyboard opening/closing, Enter vs Send,
portrait/landscape width, and reopening the same session on desktop. These must
not be marked passed solely from DOM tests or browser case discovery.

## Version and recovery

The pre-change source archive is privately retained at
`/root/agentboard-finish-20261004/source-before.tar.gz`. Browser evidence/profiles
remain in the separate October 2 audit directory and are never part of Git.

`./deploy.sh` builds into a temporary directory and requires reviewed source to
be committed. Each deployment writes `$AGENTBOARD_STATE_DIR/.releases/<release>/`
with `receipt.json` (commit and served asset hashes) and `previous-dist/`.
Only the service named `agentboard` is restarted; there is no kill-by-port fallback.
Saved notebook documents with no kernel and a stopped state can be reopened after
restart. Live kernels, unsaved documents, transitions and unknown states block it.

To recover the frontend, validate the chosen `previous-dist`, copy its assets
first, then atomically replace `frontend/dist/index.html`; retain other versioned
assets so already-open clients still load their chunks. Backend source recovery
is separate: select the recorded commit or protected source archive and review
the diff before restoring, then recheck live notebook/browser work and restart the
named service. Do not reset the working tree or overwrite data/credentials blindly.
