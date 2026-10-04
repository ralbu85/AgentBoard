# Isolated browser worker

The web server must not launch a root browser. `backend/browser_security.py`
refuses root launches and always enables Chromium's sandbox for local non-root
launches. Desktop Electron also rejects root and sandbox-disabling switches.
A failed sandbox never triggers an unsafe retry.

For a root AgentBoard server, run this worker on a Docker host that supports
unprivileged user namespaces. It runs as `pwuser`, with all container capabilities
dropped, a read-only root filesystem, private tmpfs and resource limits. It has
no server home, project, SSH key, browser profile or Docker socket mounts. Its
Playwright control port binds to host loopback only. Browser profiles are supplied
by the authenticated backend per workspace; do not import the server's desktop
browser profile or mount any credentials into the worker.

`seccomp_profile.json` is the upstream Playwright v1.63.0 profile:
https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json
SHA256: cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849
It permits the sandbox's namespace setup inside this worker only. Do not change
the application container's global seccomp policy, add SYS_ADMIN, use privileged
mode, mount host IPC, or add `--no-sandbox`.

The worker and backend are pinned together to Playwright 1.63.0, the release
verified on 2026-10-02. Rebuild the image and upgrade both together when security
updates arrive. This is a deployment template, not a tested production boundary;
the base image is intended for testing/development. Run on a dedicated host or VM
without sensitive mounts and restrict its access to internal services. See the
[upstream Docker guidance](https://playwright.dev/docs/docker).

1. Generate a 32-byte random hex `browser_ws_path.secret` outside Git. Make it
   readable only by the worker UID (1000) and the administrator (`0400`, UID 1000),
   and keep its parent directory private. Never print it in logs.
2. On the prepared Docker host, run `docker compose up -d --build` here.
3. Set `AGENTBOARD_BROWSER_WS_ENDPOINT=ws://127.0.0.1:3023/<secret>` in the
   server's protected service environment, then restart the app. For a worker
   on another host, use a private authenticated TLS tunnel (`wss://`); plaintext
   non-loopback connections are rejected. Do not expose port 3023 publicly.
4. Verify the worker UID, effective command line and a working sandbox before
   browsing external pages. The backend verifies the browser's effective flags
   before opening any page. Remote worker identity/UID remains an operator trust
   boundary; flags alone are not remote attestation.
5. From the app environment, run `backend/.venv/bin/python -m backend.browser_check`.
   It verifies safe launch/connection and a disposable `about:blank` page, then
   closes its context/connection. It never prints the private endpoint, visits an
   external site, retries without sandboxing, or imports archived root profiles.

On 2026-10-02 the current application container rejected a non-root user-namespace
probe (`Operation not permitted`) and had no reachable Docker daemon. The worker
has therefore NOT been deployed here. Unsafe server browser launches are blocked;
the desktop app on a sandbox-capable user's machine remains available.
