# Workspace foundation — 2026-09-10

Baseline checkpoint: `6a83e81`.

Implemented:
- Desktop explorer in the left sidebar; independent file tabs for each machine/path, including workspaces without sessions. Existing local session tab metadata is migrated when opening that workspace.
- Workspace selection separates identical paths on different machines. Remote filesystem access is explicitly unavailable until a host-aware file transport exists.
- Folder validation and removal of empty registered workspace entries (does not delete directories).
- Explicit session termination with confirmation and a global session manager.
- Failed writes remain unsaved; asynchronous saves update their original workspace and preserve newer edits. File hash preconditions detect external edits already present at save time. These checks do not lock out independent filesystem writers.
- Upload progress, per-file results, cancellation, streamed temporary files, 100 MiB limit, and collision protection. Changing workspace or closing the explorer cancels its active upload.
- Background agent detection now tracks stable output. Completion flashes no longer mask a new working/waiting state.
- Global unsaved-change warning and manual explorer refresh.

Still planned:
- Server-persisted workspace metadata, names, favorites and cross-device layouts.
- Remote file transport, folder/ZIP transfers, retries and resumable uploads.
- Process resource/activity history and batch session actions.
- Browser/development-server tabs and Jupyter kernel execution.
- Real Codex output fixtures for the remaining heuristic status edge cases.

Validation: frontend unit tests, backend unit tests, TypeScript/build, and isolated Chromium desktop/mobile checks with mocked sessions/files, including versioned saves, conflict handling and upload results (no live agent input or termination).

## Workspace navigation follow-up

The desktop sidebar now has a compact workspace switcher above a full-height file tree. The switcher contains searchable workspaces, drag handles, up/down controls, and confirmed removal. Mobile exposes the same controls in its workspace drawer.

Order and removed-workspace lists persist in this browser's local storage. Removal hides the workspace even when it has running sessions; it does not delete files, stop sessions, or discard editor buffers. Removed entries can be reopened. The selected workspace falls back to the next visible entry, or to an empty selection if none remain. Opening a hidden session from the session manager restores its workspace.

Verified with navigation state tests and Chromium desktop/mobile checks, including ordering across reloads, drag ordering, cancel/confirm removal, and restoration without destructive API calls.

## Persistent overview follow-up

The compact switcher was replaced by a permanently visible workspace overview, with a separate file-explorer column alongside it. This preserves at-a-glance agent status. Completion markers now persist until acknowledged; see `terminal-readability.md` for exact review semantics, client-local limitations, and the typography evaluation.
