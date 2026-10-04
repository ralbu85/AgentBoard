# Browser security review — 2026-10-02 UTC

This is a bounded local review, not proof that no information was exposed.
Private evidence, profile backups and tab URLs are in
`/root/agentboard-security-audit-20261002/` (directory 0700). They are excluded
from this repository and are not published or sent to external services.

## Findings and containment

- Three root browser parent processes were running with the sandbox disabled.
  Their identity, children, open profile files and network sockets were recorded.
  The temporary research Chrome had 18 page tabs; their URLs were saved privately.
  Both relevant browser profiles were backed up before SIGTERM was sent to the
  three verified parent PIDs. All three exited; no browser was force-killed.
- The root Chromium startup file automatically added `--no-sandbox`. Its original
  was backed up and that option removed, along with an empty `--user-data-dir`.
- The root home and browser launcher/binary allowed other accounts to write.
  Root home is now 0700; browser launcher/binary are root-owned 0755. SSH directory
  and authorized_keys are 0700/0600; profile directories are 0700. Authentication
  key contents were not changed. Credential values were not printed or sent outside the server.
- The application now refuses local root browser launches and requires the
  Chromium sandbox for local non-root launches. The desktop app and its
  integration tests refuse root and sandbox-disabling options. An isolated
  worker configuration is under `deploy/browser`; it is not running in this
  namespace-restricted environment. No global kernel/container restriction was
  relaxed. No public debugging port was created.

## Exposure review and limits

- Retained auth.log contains no September/October accepted or failed SSH login
  events. authorized_keys was last modified on August 13, before the browser
  experiments. The retained successful logins are from loopback, which does not
  establish the identity behind a proxy/tunnel.
- Chromium/SSH package verification reported missing configuration/documentation
  files, but no executable content mismatch. Missing files alone are not evidence
  of compromise, and package checks cannot establish the integrity of all code.
- Root crontab entries correspond to the existing mail classifier and environment
  maintenance/backup scripts. This review did not execute those jobs.
- The recorded research Chrome debugging listener was on 127.0.0.1:9223. It was
  removed when the browser exited. Loopback exposure is still accessible to other
  local processes and is not an authentication mechanism.
- No file-access audit log or historical network payload/egress audit was
  available. Application/proxy logs did not provide a complete request history.
  Several existing log files were writable by other accounts, weakening their
  value as forensic evidence. Browser cache/history and connection snapshots
  cannot prove whether secrets or project files were exfiltrated.

No confirmed exfiltration or new SSH intrusion was identified in these checks.
Exfiltration cannot be ruled out. The stopped browsers had had root access inside
this container, including mounted workspaces. For a high-assurance incident
response, obtain host/network logs and rotate credentials that may have been
accessible; revocation must be coordinated so ongoing agents/access are retained.
No credentials were revoked and no user sessions or project files were deleted.

## Applied verification

The backend was restarted with zero live notebook kernels and zero server browser
tabs. All 37 pre-restart tmux session/pane process identities were retained. An
authenticated request to the live browser WebSocket returned the root-launch
security error before any page navigation. No live Chrome/Chromium/WebKit
process remained after containment.

The backend driver and isolated worker template now both use Playwright 1.63.0,
verified against the official release on this date. Only the Python driver was
installed in the app virtual environment; no browser binary was downloaded or
launched for the upgrade. The second restart again retained all 37 pane process
identities, and the live root-launch guard was checked again after restart.
Backend tests: 145 passed, 1 skipped. Desktop policy/unit tests: 3 passed.

The mobile frontend was deployed as `safe-mobile-security-20261002`. Previous
static files were backed up under `/tmp/agentboard-before-safe-mobile-20261002-141655/`;
served HTML/JavaScript/CSS were checked against the staged build. Frontend tests:
156 passed; TypeScript/Vite build passed. No browser integration test was run
without a working sandbox. The new mobile renderer still requires a real iPhone
check; automated DOM tests cannot establish native momentum/selection behavior.
