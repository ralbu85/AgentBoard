# Workbench and readability — 2026-09-10

The layout is workspace/session overview | independent file explorer | unified terminal/file tabs. Each session remains visible in its workspace; selecting it opens its terminal tab. Closing a terminal tab keeps its process alive. Explicit manual session names take precedence over the automatic tmux pane title. Legacy generic labels such as “claude #1” no longer mask automatic titles; missing titles show “제목 대기” without a numeric identifier. Each workspace always expands its sessions into individually bordered rows with wrapped titles and launch times.

Workspace handles and viewer tabs support drag reordering. Workspace removal still asks for confirmation and keeps the underlying directory and sessions. Tab order and last selected workspace/file persist in this browser. PDF page/zoom, editor scroll/cursor, document scroll, expanded folders and explorer scroll are restored. File positions also survive closing and reopening a tab. Unsaved file contents are intentionally not stored in localStorage; closing dirty tabs or leaving the app requires confirmation.

## Colors and completion review

Workspace groups have dark headers, visible borders and spacing. Selection uses a dark violet tint and a narrow accent edge. Secondary labels have higher contrast. The cyan “미확인” badges are removed. New completion is a muted amber accent and “완료 · 새 소식” on the session row only. Clicking a session or its terminal tab clears its marker; clicking a workspace heading clears that workspace's markers. A later completion marks the session again. Automatic selection and reload do not acknowledge results. Markers are browser-local and depend on received status transitions; agent state detection remains heuristic.

## Applied readability changes

- Terminal default 15px, compact line height 1.0 (also replaces the previous saved 1.25 default), no automatic font shrinking. A− / A+ / reset controls persist 12–22px preferences.
- Adaptive width uses 30–80 columns within the existing server protocol; a fixed 80-column option remains available.
- Korean terminal and input text use a bundled, renamed Hangul subset of NanumMyeongjo (SIL OFL, license included); Latin terminal text retains D2Coding.
- Brighter ANSI gray and minimum text contrast 4.5. The toolbar stays above terminal output.
- PDF current/total page display, page slider, previous/next buttons, zoom and reload preserving the current page. Canvas painting is limited to pages near the viewport.

## Validation

Frontend store/readability/terminal/API tests and backend tests pass. Isolated Chromium checks cover unified tabs, automatic titles, PDF slider/page restoration, document/editor scroll restoration, workspace/tab drag ordering, reload persistence, click-to-clear sidebar markers and mobile file viewing. Production tmux sessions are preserved when the app server restarts.

## Session input drafts

Input drafts are stored per machine/session/workspace in this browser. Switching sessions, workspaces or file tabs and reloading preserves them. Successful send clears only the submitted draft if it has not changed during the request. Failed sends keep the text; newer typing and delayed uploads stay associated with their original session. Korean IME composition does not trigger Enter-to-send.

Follow-up validation: 32 frontend tests pass. An isolated Chromium fixture with two agents in one workspace verifies expanded rows, independent drafts across navigation and reload, failed and delayed sends, completion dismissal, legacy title replacement and loaded Korean serif font. No real agent input is sent during verification.
