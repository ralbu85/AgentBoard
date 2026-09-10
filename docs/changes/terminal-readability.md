# Workbench and readability — 2026-09-10

The layout is workspace/session overview | independent file explorer | unified terminal/file tabs. Each session remains visible in its workspace; selecting it opens its terminal tab. Closing a terminal tab keeps its process alive. Explicit manual session names take precedence over the automatic tmux pane title. Legacy generic labels such as “claude #1” no longer mask automatic titles; missing titles show “제목 대기” without a numeric identifier. Each workspace always expands its sessions into individually bordered rows with wrapped titles and launch times.

Workspace handles and viewer tabs support drag reordering. Workspace removal still asks for confirmation and keeps the underlying directory and sessions. Tab order and last selected workspace/file persist in this browser. PDF page/zoom, editor scroll/cursor, document scroll, expanded folders and explorer scroll are restored. File positions also survive closing and reopening a tab. Unsaved file contents are intentionally not stored in localStorage; closing dirty tabs or leaving the app requires confirmation.

## Colors and completion review

Workspace groups have dark headers, visible borders and spacing. Selection uses a dark violet tint and a narrow accent edge. Secondary labels have higher contrast. The cyan “미확인” badges are removed. New completion is a muted amber accent and “완료 · 새 소식” on the session row only. Clicking a session or its terminal tab clears its marker; clicking a workspace heading clears that workspace's markers. A later completion marks the session again. Automatic selection and reload do not acknowledge results. Markers are browser-local and depend on received status transitions; agent state detection remains heuristic.

## Applied readability changes

- Terminal default 15px, compact line height 1.0 (also replaces the previous saved 1.25 default), no automatic font shrinking. A− / A+ / reset controls persist 12–22px preferences.
- Adaptive width uses 30–80 columns within the existing server protocol; a fixed 80-column option remains available.
- Terminal and input text use D2Coding, a coding-oriented fixed-width font. The experimental serif font has been removed.
- Brighter ANSI gray and minimum text contrast 4.5. The toolbar stays above terminal output.
- PDF current/total page display, vertical page slider, previous/next buttons, zoom and reload preserving the current page. Canvas painting is limited to pages near the viewport.

## Validation

Frontend store/readability/terminal/API tests and backend tests pass. Isolated Chromium checks cover unified tabs, automatic titles, PDF slider/page restoration, document/editor scroll restoration, workspace/tab drag ordering, reload persistence, click-to-clear sidebar markers and mobile file viewing. Production tmux sessions are preserved when the app server restarts.

## Session input drafts

Input drafts are stored per machine/session/workspace in this browser. Switching sessions, workspaces or file tabs and reloading preserves them. Successful send clears only the submitted draft if it has not changed during the request. Failed sends keep the text; newer typing and delayed uploads stay associated with their original session. Korean IME composition does not trigger Enter-to-send.

Follow-up validation covers both store logic and browser behavior. An isolated Chromium fixture with two agents in one workspace verifies expanded rows, independent drafts across navigation and reload, failed and delayed sends, completion dismissal, legacy title replacement and the loaded coding font. No real agent input is sent during verification.

## Persistent split workbench and reading positions

Tabs can be dragged to a pane edge to split left/right/top/bottom, or to its center/tab bar to move between panes. The two toolbar split buttons move the selected tab right or below; open at least two tabs in that pane. Drag the divider (or use its arrow keys) to resize. Merge reunites the tabs. Direction, ratios and per-pane selections are stored per workspace and restored after switching workspaces or reloading. Layout restoration waits until saved tabs have loaded. Multiple terminal panes remain visible independently.

PDF documents share in-flight loading and parsed-document caches (up to four unused/recent documents and a 64 MiB source-byte budget; mounted documents hold leases). Explicit refresh invalidates the cached document. Canvas painting remains limited to nearby pages. Placeholder pages cannot shrink to zero, so scroll anchors stay stable before painting. Each PDF retains page, fractional position within that page, zoom and horizontal offset across tab changes, workspace changes, close/reopen and reload. Reloading the browser necessarily rebuilds the memory cache.

PDF page navigation is a vertical rail on the right. Other file views have a percentage-based vertical slider connected to the actual scroll container, including CodeMirror. Workspace cards never flex-shrink: long lists scroll instead of clipping their lower session rows. Opening a workspace prepares a separate terminal tab for every session while preserving the selected file.

## State stabilization and completion identity

Reading a snapshot no longer changes agent state. Foreground and background observers share normalized content samples; ANSI colors, cursor movement and wrapping are excluded from the activity signature. Typed agent prompts remain idle unless an explicit busy indicator is present. Starting work requires 0.6 seconds of an explicit busy indicator or 3 seconds of continuously changing ambiguous output. Finishing work requires 2 seconds of a stable idle candidate. This avoids the synthetic working→idle cycle caused by selecting/resizing a completed terminal.

Completed turns carry a content-derived completion identifier. Explicit user submissions distinguish repeated identical answers from separate turns. The browser suppresses repeated identifiers after acknowledgement, including state replay, while a different result can notify again. The temporary green completed-turn flash is removed: live state and unread result are independent. Process exit still has its actual completed state. Older remote agents without identifiers retain legacy notification compatibility; upgrade their shared backend modules to get server-side stabilization and result identities. Terminal state inference remains heuristic and is not an agent-provided lifecycle hook.

Validation includes 17-session crowded sidebars, concurrent PDF and terminal panes, horizontal/vertical splits, divider ratios across reload, vertical sliders for PDF/Markdown/code, cached PDF fetch counts, exact reading-position restoration, draft isolation and failed/delayed sends, and duplicate-versus-new completion events. All browser automation uses mocked commands; it sends no input to real agent sessions.
