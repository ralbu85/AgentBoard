# AgentBoard

Browser-based dashboard for managing multiple AI terminal sessions via tmux.

## Architecture

**Backend**: FastAPI + uvicorn (Python 3.12)
**Frontend**: React 19 + xterm.js 5.5 + Zustand + Vite + CodeMirror 6
**Proxy**: nginx on port 12019 → backend on port 3002
**Terminal**: tmux sessions, capture-pane polling (80 ms active, 2 s background)

### Multi-machine (Hub + Agent)
AgentBoard aggregates tmux sessions from several PCs in one dashboard. The existing
backend is the **hub** (serves browsers). Each remote PC runs a lightweight **agent**
(`agent/`) that dials OUTBOUND to the hub (`/agent-ws`) — works behind NAT. The agent
reuses the backend's `tmux`/`sessions`/`streamer`/`state_detector` modules in its own
process, so each agent has its own private module globals (no cross-process sharing).
The hub is a pure relay for remote hosts: it never runs streamer/tmux for a remote id.

- Hub-local sessions keep bare ids (`"3"`), host implicitly `"local"` — unchanged.
- Remote sessions are exposed to browsers as `"<host>:<localId>"` (e.g. `office:3`).
- ID translation happens in exactly two places: ingest (`agent_ws` → `namespace.prefix_msg`)
  and egress (`ws`/`routes_session` → `namespace.split_id`).
- Agent↔hub protocol = the existing browser protocol verbatim; the hub just adds a
  `host` tag on ingest. New control frames: `register`/`register-ack`/`ping`/`pong`.
- Adding a machine: on the remote PC, clone repo + venv, then `agent/start-agent.sh`
  with `AGENT_HUB_URL`, `AGENT_TOKEN`, `AGENT_HOST_ID`, `AGENT_HOST_LABEL`.

### Backend (`backend/`)
- `main.py` — FastAPI app, lifespan, static file serving (no-cache on all assets)
- `agents.py` — AgentRegistry: connected agents + per-host session mirror (hub only)
- `agent_ws.py` — `/agent-ws` endpoint: register/token auth, ingest relay (hub only)
- `commands.py` — `apply_command(store, streamer, tmux, msg)`: single mutation point
  shared by the hub's local path and every agent
- `namespace.py` — `split_id`/`prefix_id`/`prefix_msg` for cross-machine session ids
- `config.py` — .env loading, auth token, project root
- `auth.py` — Cookie-based auth (HMAC-SHA256), per-IP login throttling
- `logger.py` — structured logging (no `print`, no silent `except`)
- `sessions.py` — SessionStore: spawn / kill / remove / recover tmux sessions
- `streamer.py` — pipe-pane FIFO streaming + capture-pane polling + state detection
- `state_detector.py` — idle / working / waiting detection from terminal output
- `tmux.py` — async tmux command wrappers
- `ws.py` — WebSocket endpoint, auth check, message routing, broadcast
- `routes_session.py` — REST: login, workers, spawn, kill, input, key, health
- `routes_file.py` — REST: browse, files, read / write / upload (path-traversal safe)
- `routes_preview.py` — read-only files of a previewed HTML page's project, under a signed expiring token (the sandboxed iframe has no cookie)
- `tunnel.py` — Cloudflare tunnel (optional)
- `push.py` — Web Push (VAPID): fires an OS notification when a session goes
  `waiting`/`completed`; subscriptions persisted, deduped per session
- `models.py` — Pydantic request models with length limits

### Frontend (`frontend/src/`)
- `App.tsx` — root, login flow, layout
- `main.tsx` — entry point
- `store.ts` — Zustand state (sessions, activeId, titles, toasts)
- `ws.ts` — WebSocket singleton with exponential-backoff reconnect
- `api.ts` — REST API fetch wrappers
- `markdown.ts` — marked + KaTeX inline rendering
- `sanitize.ts` — DOMPurify wrapper for `dangerouslySetInnerHTML`
- `toasts.ts` — toast helpers
- `appUpdate.ts` — notices that a deploy replaced the build this page runs and offers a reload (saves open files first)
- `types.ts`, `globals.d.ts` — shared types
- `components/Terminal/`
  - `TerminalManager.ts` — xterm.js lifecycle, mobile scroll, snapshot/screen application
  - `TerminalPane.tsx` — terminal container + scroll-to-bottom button
  - `InputCard.tsx` — input textarea + quick keys
- `components/Sidebar/` — session list with filter, mobile overlay
- `components/Viewer/` — split layout, code editor, file content, PDF, Jupyter notebook (runs cells; markdown cells edit where they are rendered), resizer
  - `DocSurface.tsx` — every text file tab (code, LaTeX, HTML, Markdown/Quarto): one toolbar (미리보기 / 나란히 / 소스, ✎ 텍스트 편집, ↶, save state), one disk banner; a format only supplies its rendered view through `DocEdit`. Notebooks reuse its toolbar pieces and ✎ toggle
  - `docSync.ts` — the one save policy: autosave (1 s after typing, at once on a committed edit), disk follow via `/api/file-stat`, conflict handling; `useFileChanges` reloads PDFs/images
  - `HtmlPreview.tsx` — HTML rendered view (sandboxed iframe, click-to-edit text); `htmlSource.ts` — parse5 source mapping for preview edits (lazy chunk); `htmlPreviewRuntime.ts` — the script injected into the iframe
  - `MarkdownPreview.tsx` — Markdown/Quarto rendered view: click a paragraph, heading or list item to edit its text where it is rendered (other blocks and 원문 open the block's own markdown); `markdownBlocks.ts` — block → source-range map, Quarto rendering (front matter, callouts, columns, cells, includes, saved outputs) and block edits; `quartoSources.ts` — loads a Quarto document's includes and last run; `markdownEnhance.ts` — code colours and Mermaid diagrams; `markdownInline.ts` — a block's inline pieces (text / formatting / atoms) and their source, for editing it rendered
- `components/SpawnModal/` — new-session dialog
- `components/FilePanel.tsx` — file browser
- `components/PdfViewer.tsx` — PDF rendering (pdfjs-dist, lazy-loaded)
- `components/Header.tsx` — status bar, + New
- `components/Login.tsx` — password login
- `components/Toaster.tsx` — toast container

## Commands

```bash
# Setup
cd /workspace/BALAB_Prof/agentboard
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install

# Build + restart (production)
./deploy.sh                                 # builds frontend, restarts server, polls /api/health

# Backend only
./start.sh

# Frontend dev with HMR (proxies API to :3002)
cd frontend && npm run dev

# E2E screen-fidelity test (needs the server running): spawns a real session,
# collects real WS frames, replays them through headless xterm.js, and
# byte-compares against tmux (visible area, burst scrollback, CJK/emoji, cursor)
./tools/fidelity/run.sh
```

## Key Design Decisions

### Terminal Output
- `writeScreen` (capture-pane polling 80 ms) — overwrites visible area in-place with `\x1b[H` + lines + `\x1b[J`
- `writeStream` (pipe-pane FIFO) — **disabled on client** because raw escape sequences destroy scrollback
- `writeSnapshot` (capture-pane -S -2000) — one-time on session switch, **applied atomically** (single `terminal.write` of full payload)
- When user scrolls up: writeScreen still runs but **preserves scroll position** via saved scrollTop
- Adaptive cadence: active session = 80 ms, background sessions = 2 s

### Mobile (CRITICAL)
- Mobile uses a native text/scroll document; desktop retains xterm.
- Never restore synthetic momentum, relocate xterm internal DOM, or send swipe gestures to the PTY.
- Native iPhone selection/menu stays enabled. Copy maps visual wrapping back to source text.
- Enter in the phone input adds a newline; only Send submits.
- Mobile never resizes the shared PTY or automatically shrinks the font.
- Original-message reading is available through the authenticated conversation view.
- See `docs/terminal-viewports.md` for source limitations and verification status.
- All browsers, including demos/tests, must follow `AGENTS.md`: non-root and sandbox enabled.

### Caching
- All assets: `Cache-Control: no-cache, no-store, must-revalidate`
- Fixed filenames (`app.js`, `index.css`) — no content hashes
- Cache-bust via `?v=<timestamp>` injected by `deploy.sh`
- **NEVER add client-side `setTimeout` auto-reload** — loops on slow mobile

### Server Startup
- Always run from project root: `cd /workspace/BALAB_Prof/agentboard && python -m backend.main`
- `start.sh` and `deploy.sh` handle this — use them, don't invent commands
- Module name is `backend.main` (no `v3.` prefix — legacy)
- `deploy.sh` polls `/api/health` for readiness, doesn't `sleep`

### Concurrency
- `spawn()` reserves the session id **synchronously** before the first await — fixes a race that produced duplicate ids
- WebSocket reconnect uses **exponential backoff** — naive reconnect floods on outage
- WebSocket upgrade authenticates the cookie — never trust the connection

### Security
- Pydantic models on every endpoint with explicit length limits
- Path traversal blocked in file API (resolved path must stay under project root)
- tmux `pipe-pane` shell command is **defanged** — session ids/paths are validated, not interpolated raw
- HTML through `dangerouslySetInnerHTML` is sanitized via `sanitize.ts` (DOMPurify)
- Login throttled per IP

## Pitfalls — don't repeat these

> Each entry comes from an actual bug or scope decision. Read before "improving" the relevant area.

### Terminal / rendering
- **Don't apply snapshots incrementally.** Stacks the scrollback every switch. Build the full payload, write once.
- **Don't pipe raw `pipe-pane` output to xterm.** Escape sequences shred the scrollback. We poll `capture-pane` instead.
- **Don't `screen`-broadcast (visible-only) when scrollback grew between polls.** `capture-pane -S 0` only sees the post-burst viewport, so anything that scrolled off during a fast burst (`cat largefile`) vanishes from the client. `_poll_active` re-snapshots when scrollback grows. Stream-style append doesn't work here either — it duplicates already-visible lines and leaves cursor in the wrong row. Atomic snapshot is the only correct option.
- **Don't trust `#{history_size}` as the scrollback-growth signal.** At the history-limit cap tmux trims the oldest lines in *batches*, so the size oscillates and even **shrinks** while new lines keep scrolling in (measured: 1964→1865 right after 500 new lines) — size-only detection silently drops the last burst. `_poll_active` compares the last 5 scrollback lines (`capture-pane -S -5 -E -1`) as the primary signal; trims eat the top, so the bottom only changes on real growth.
- **Don't re-broadcast growth snapshots unthrottled.** While a session streams, history grows on nearly every 80 ms poll — unthrottled that's a full 2000-line ANSI snapshot per poll. `SNAPSHOT_MIN_INTERVAL` (0.5 s) gates them; cheap `screen` frames keep the visible area fresh in between. Keep the growth baseline unchanged while throttled so the growth is retried, not lost.
- **Don't apply a snapshot while the user is scrolled up.** `writeSnapshot` erases the whole buffer (`\x1b[3J`) and pins to bottom — during streaming that yanks the reader to the bottom every snapshot ("scroll is broken"). `TerminalManager` defers the *latest* snapshot while `isScrolledUp` and flushes it when the viewport returns to the bottom (writeScreen / scrollToBottom / TerminalPane's 300 ms poll).
- **`alternate-screen off` blocks the alt-screen *exit* sequence too — a pane already inside gets STUCK.** Restarting the app does NOT help: the old app's leave-alt sequence is ignored, `#{alternate_on}` stays 1, and the relaunched app renders into the alt grid where scrollback never accumulates ("exit하고 재시작해도 스크롤 안 됨"). Fix: while a pane reports alt-screen, the streamer grants a window-*local* `alternate-screen on` so the app's eventual exit is honored, then removes the override once it leaves (re-blocking entry) — see `_update_info` / `tmux.allow_alt_screen_exit`. Every stuck pane converges at its app's next exit.
- **A user's `.bashrc` `cd` overrides the spawn cwd for `bash` sessions.** `tmux new-session -c <folder> bash` starts bash in the folder, then `.bashrc` runs and can `cd` elsewhere — the `-c` flag is fine, don't debug tmux. On this box `/root/.bashrc` had an unconditional `cd /workspace`; it's now guarded with `[ "$PWD" = "$HOME" ]` (machine config, not in this repo). `claude`-profile spawns are unaffected (`sh -c` doesn't read `.bashrc`).
- **Don't fight xterm's touch handlers — disable them.** `pointer-events: none` on `.xterm*` and ride your own.
- **Mobile copy is manual — native selection is off.** With `pointer-events:none` there's no long-press-select, so copy is bespoke: a stationary 500 ms long-press on `.xterm-wrap` copies the logical line under the finger (`_logicalLineAt` joins xterm's `isWrapped` continuation rows so a wrapped URL copies whole); a real touchmove (>10 px) cancels it as a scroll. A `⧉ 복사` button copies the visible screen. Clipboard writes go through `copyText` (navigator.clipboard + hidden-textarea/`execCommand` fallback — `navigator.clipboard` is undefined on plain-HTTP LAN).
- **Don't trust Playwright/CDP touch direction.** It's inverted vs real devices. Verify on a phone.
- **Don't tune polling globally.** Adaptive only — active fast, background slow.
- **Route `screen`/`snapshot` to viewers, broadcast the rest to all.** `ws.broadcast` sends per-session frames only to browsers viewing that id (`_viewers_of` → `streamer.local_viewers` / `_ws_remote`); a busy session's multi-KB frames otherwise ship to every connected browser (mobile data). Grid mode is unaffected — non-focused tiles refresh via `resync`'s *direct reply*, not broadcast. Lightweight frames (status/aiState/info/spawned/removed/title) still fan out to all — the sidebar needs them.
- **Cap live xterm instances (LRU) — each holds a ~10k-line buffer (~6-10 MB).** Visiting many sessions leaves them all resident until the phone force-reloads the tab. `TerminalManager._evict` keeps `MAX_LIVE_TERMINALS` (mobile 4 / desktop 12) most-recently-used, disposing the rest; a disposed session rebuilds from its next snapshot on re-open. NEVER evict the active session or a mounted/visible tile (grid shows several) — the eviction loop skips both.
- **Deep scrollback beyond the streamed snapshot goes through `/api/capture`, not a bigger snapshot.** xterm can't prepend to its buffer and a larger `SNAPSHOT_HISTORY` bloats every frame, so "전체 로그" fetches the full `capture-pane -S -<HISTORY_LIMIT>` as plain text and opens it in the viewer (`openLogTab`, ephemeral `log:` id, never persisted). Desktop + local sessions only — the viewer isn't mounted on mobile and a remote capture would need an agent round-trip.
- **`capture-pane` carries NO cursor position — send it separately or typing lands wrong.** A frame rendered from capture alone leaves the client cursor at the end of the content, not where tmux's pane cursor is (desktop direct-typing then edits at the wrong column). `tmux.capture_with_cursor` chains `display-message #{cursor_x};#{cursor_y};#{cursor_flag}` onto the SAME capture invocation (no extra subprocess) and `streamer._cursor_suffix` appends a RELATIVE move (`\r`, CUU/CUD, CUF) after the frame — relative so the one suffix is correct for both `screen` frames and snapshots regardless of client row count. A cursor move with no content change still counts as a change (arrowing a prompt).
- **Load `@xterm/addon-unicode11` — it's installed but inert without `unicode.activeVersion='11'`.** xterm's default width table disagrees with tmux on some emoji; every box-drawing border after a mismeasured glyph shifts right (Claude Code UI is emoji-heavy). Two lines in `TerminalManager.create`.
- **Don't size a session only when someone looks at it.** Agents print at the PTY width and that layout sticks in scrollback, so per-session negotiation left live sessions at 80, 168 and 240 columns side by side ("창마다 해상도가 다르다"). All sessions share `viewports.shared_cols`: new sessions start at it and `_poll_background` moves unfitted ones to it. Only a visible split pane or grid tile fits its own width, and the reported width comes from `.main-area` in that case so opening a viewer doesn't reflow every session.
- **Don't let a width change look like work.** A resize redraws the TUI, which reads as activity (reorders "recent work") and can flip `waiting` → `idle` → `waiting` (a fresh push notification). `resize_grid` sets `_reflow_until` and `_detect_state` skips that window, then takes its next sample as a new baseline. `MAX_ALIGN_PER_CYCLE` keeps background resizes from redrawing every session at once.
- **Claim from recent input, never from `document.hasFocus()` or heartbeats.** A browser left open on another PC is still visible and can still report focus, so either signal makes two machines fight over the width every 5 s and redraws live processes.
- **Batch liveness checks — one `list-sessions`, not N `has-session`.** `_poll_background` forked `tmux has-session` per session every 2 s (17 sessions = 17 forks/cycle). `list_sessions()` returns all live names in one call; empty set == server down == all dead. (The per-session `display_info`+tail capture for state detection still forks 2×/session/cycle — that's the dominant background cost, a later optimization.)

### File editing (DocSurface, previews, notebooks)
- **Don't write the iframe's DOM back to the file.** Page scripts rewrite their own DOM (slide classes, wrappers, rendered math), so `outerHTML` would bake that into the source. Each start tag gets a `data-ab-i` ordinal (parse5 source offsets — same tree construction as the browser); an edit replaces only that element's inner source range, and only after the parent confirms the normalized source still equals the DOM's `before` (else: "페이지 스크립트가 바꾼 내용").
- **Parse the file behind the same head the iframe sees.** `htmlSource` parses `SHAPE + file` so `<html>`/`<head>` merge and the insertion mode match the preview; parsing the file alone gives ordinals for elements that don't exist in the iframe.
- **Don't reload the preview for preview edits.** A reload re-runs the deck's scripts and drops the reader back to slide 1. The parent answers each edit with patches (inner/after/remove + ordinal shift); it reloads only when the rest of the file would parse differently or the iframe is stale. Disk/source changes do reload, with scroll + hash restored.
- **A previewed HTML page loads its project's files through a signed address, not the cookie.** The iframe's opaque origin gets no session cookie, so `/api/preview-base` (cookie-checked) issues `/api/preview/<token>/` for the page's project (nearest folder with `.git`/`_quarto.yml`, so `../site_libs` resolves), read-only, a day long, dot-files refused, every response `CSP: sandbox` so an HTML file opened from it can't act as the app. The page gets a `<base>` for its folder; its CSP allows that prefix and the common CDNs and nothing else, so what it reads can't be sent anywhere. With a `<base>`, `#s2` would load the folder: the runtime moves same-page fragments itself and hands other links to the parent (a project page opens in a tab, anything else in a new window).
- **The injected runtime is `previewRuntime.toString()` — keep it self-contained.** No imports or module-scope references, and nothing that reads `</script`. It captures `parent.postMessage` and removes its own `<script>` before page scripts run; messages carry a per-load token, so page `postMessage` traffic (reveal.js events) is ignored.
- **A srcdoc page can't change its URL — the runtime absorbs `history.pushState`/`replaceState`.** The iframe document is `about:srcdoc` but resolves URLs against the app's, so a deck's `replaceState(null, '', '#3')` throws a SecurityError. Decks that call it during startup (the STML slides) stopped there, before scaling their slides to the window. The runtime wraps both, swallows the error and keeps the fragment so a reload returns to the same slide.
- **Edit mode claims a click only for text it would edit.** Swallowing every click (to keep click-to-advance decks still) also ate the deck's own ‹ › buttons, and a button's arrow text opened as an editor instead. Controls (`button`, form fields, `summary`, ARIA roles, links laid out as blocks) and symbol-only text (`→`, `▶`) stay the page's; inline links in a sentence are still edited as text.
- **Use `contenteditable="plaintext-only"` and swallow page events while editing.** Rich mode inserts style spans/`<div>`s; deck keyboard handlers would turn arrow keys and Space into slide changes. Enter checks `isComposing` (Korean IME).
- **One surface, one save policy — don't give a format its own.** HTML, Markdown and code tabs each had their own toolbar, save rule (autosave vs Ctrl+S vs 💾) and disk handling; users couldn't predict any of it. `DocSurface` owns modes, ✎, undo, save state and the banner; `docSync` owns saving and disk follow. A new format adds a rendered view that edits through `DocEdit.apply` (an undo step + an immediate save) and registers `setPaused` while an inline editor is open.
- **원문 means the same everywhere: the part being edited, in its source.** Markdown opens the block's markdown in place; an HTML file is its own source, so 원문 switches to 나란히 and selects the element's range (`DocEdit.showSource`, parse5 offsets, `CodeEditor.reveal`); a notebook cell opens its markdown, and the notebook's 소스 shows every markdown cell's.
- **Every save goes through `store.saveTab`.** It chains writes per tab, so autosave, Ctrl+S and closing a tab never send two writes with the same `expectedVersion` (the second would 409 against the first). A closing dirty tab saves instead of asking.
- **A conflict stops autosave until the reader picks a version.** When the tab and the file both changed, retrying would 409 every second, and saving without the version check would erase the agent's write. The banner offers the disk version or "이 탭 내용으로 저장".
- **Poll `/api/file-stat`, not `/api/file`.** Every open file checks once a second; re-reading the whole file each time is a lot of traffic on mobile. PDFs/images reload only once the signature holds still for a tick — a PDF being written is otherwise loaded half-finished.
- **The HTML preview's 새로고침 reads the file from disk first (`DocEdit.reread`).** It used to re-run the page from the tab's copy, so it showed the old file whenever the poll hadn't ticked yet or was held by an open editor ("새로고침하면 바로 반영되어야"). Poll requests time out after 10 s (`quietJson`); one that never answered left the poll `busy` for good.
- **Esc keeps the text in every inline editor; only 취소 drops it.** Autosave makes Esc-as-cancel the one way to lose typing; ↶ undoes a committed edit instead.
- **Notebook autosave must not be an operation.** The `save` action shown as an operation disables the cells (read-only) for its round trip, eating keystrokes. `autosaveNotebook` runs it quietly in the queue, skips running cells (their outputs save once the run ends) and a changed file. A disk change auto-loads only with no unsaved work and no kernel — `reload` restarts the kernel.
- **A notebook markdown cell is a `MarkdownPreview` with a `DocEdit` of its own — don't give cells another editor.** `NotebookView.cellDoc` finds the cell by `id` (index for old notebooks without ids), writes through `editNotebook` and autosaves at once; ↶ is per cell and refuses when the source no longer equals what the edit wrote (an agent changed it since). An open editor holds the notebook's disk reload. Cells are read-only during a run or operation: an edit arriving then would conflict with the outputs, so an editor left open as a run starts copies its text to the clipboard instead. 원문 (and an empty cell) opens the whole cell's markdown. Checked on 3.8k markdown cells of real notebooks: 97.7% of paragraphs, headings and items edit rendered.
- **Markdown blocks map to source ranges; a container whose lines don't map stays read-only rather than guessing.** Each block element carries `data-mb`; `markdownBlocks` maps it to a source range (marked's token `raw`s tile the source; list items and quotes lex their children from prefix-stripped text, mapped back line by line).
- **Never write rendered text back as markdown — it has lost the `**`, `$…$` and `[@key]` it came from.** Editing a paragraph, heading or item where it is rendered goes through `markdownInline`: the block's inline markdown is lexed again into text pieces (written back through a character map, so an entity, escape or smart dash next to the edit survives), formatting wraps (their markers stay around what is left inside) and atoms (math, citations, images: kept or deleted whole). The pieces are rendered by the document's own renderer and must reproduce the text on screen; anything else (inline HTML, a mismatch) opens the block's markdown instead. Checked on 38k blocks of real `.md`/`.qmd` files: 97.6% edit rendered, the rest (mostly inline HTML) open as markdown; `inlineModel` refuses any block that would not read back byte-identical untouched.
- **Write nested lines back with the source's own prefixes (`MdBlock.prefixes`), not a recomputed indent.** `>>` quotes, lazy continuation lines and whitespace-only lines in code would otherwise change on every save. Checked against 33k blocks in real `.md`/`.qmd` files: an unchanged block writes back byte-identical.
- **Don't re-render the document under an open block editor.** The editor is mounted next to (or inside) the rendered element, so `MarkdownPreview` freezes what it shows and registers `DocEdit.setPaused`, which holds disk loads (and undo) until the editor closes.
- **A Quarto preview pairs saved outputs with cells by number, not order.** `useQuartoSources` reads the last run (`_freeze/<path>/execute-results/html.json`, via `/api/quarto-freeze`) and includes (nested, read-only, opened with their label's link), and follows both on disk. The run numbers every cell (`execution_count`, `eval: false` ones too) but leaves out a cell that shows nothing (code hidden, no output) or has `include: false`; pairing in order shifted every output after such a setup cell. A cell whose code differs from the run's is labelled as an older result. Checked on the deep-learning course: 361 outputs over 27 documents, all paired, every figure found.
- **Code colours and Mermaid diagrams are added after the document renders (`markdownEnhance`) and change no text or block.** A diagram is an `<img>` of the SVG (it can't run script or reach the page), inside the block's `<pre>`, so a click still opens its source; a diagram that doesn't parse keeps its source with a note. `mermaid` loads only when a document has one.
- **Quarto is rendered approximately, in the browser.** marked plus extensions for front matter, fenced divs (callouts, columns, conditional content), cells, spans, citations and smart dashes. Cells aren't executed and OJS doesn't run; Quarto's own render is the reference. Running `quarto render` per edit would take seconds and gives no source map. CRLF files render read-only (marked rewrites line endings).

### Mobile / UI
- **Don't auto-reload from the client.** Slow mobile + reload script = infinite loop. Cache-bust on the server side instead.
- **An open page keeps running the old build after a deploy.** Nothing inside it (a view's 새로고침) can show the new app. `appUpdate` compares the entry chunk the served `index.html` names with its own on WS reconnect (a deploy restarts the server) and on focus, then shows a notice with a 새로고침 button; the preview's 새로고침 reloads the app instead when it is outdated. Still user-initiated, never automatic.
- **Don't asymmetrically resize fonts on keyboard show/hide.** Viewport jitters; users lose their place.
- **Don't apply every `visualViewport` resize to `--vvh` (app height).** The keyboard slide fires a burst of resizes (per-frame app reflow = "화면이 보였다 안 보였다" flicker), and the Korean IME suggestion bar toggles ~50px on nearly every keystroke. `main.tsx` debounces to settle-once (120 ms) and ignores <100px wobbles while an input is focused (re-synced on `focusout`).
- **Don't forget to re-fit the terminal on session switch and font change.** Saved scrollTop must be restored after fit.
- **Don't shrink the mobile font to fit 80 cols — it goes to ~8px and is unreadable.** `CANONICAL_COLS` is fixed at 80 for cross-client consistency, so fitting 80 cols to a phone width forced a tiny font. Mobile now uses a FIXED readable font (`TARGET_FONT=14`; `refit` skips the width-shrink on mobile) and the 80-col grid overflows horizontally (`.xterm-wrap` `overflow-x:auto` + `touch-action:pan-x`). Bonus: a fixed font also stops the keyboard show/hide font jitter. Mobile `.input-textarea` is 16px (also stops iOS focus auto-zoom, which triggers under 16px).

### Concurrency
- **Don't `await` before reserving a session id in `spawn()`.** Two parallel spawns will collide. Reserve sync, fill async.
- **Don't reconnect the WebSocket on a tight loop.** Backoff exponentially with a cap.
- **Don't `write_text` JSON state in-place.** A SIGTERM between truncate and write leaves a half-written file; on next start `_load_titles` parsed an empty/garbage file, reset `_titles` to `{}`, and the next save committed the wipe to disk. Atomic write (`tmp + os.replace`) + don't auto-overwrite an unparseable file (rename to `.corrupt-<ts>` first) — see `sessions.py`.

### Security
- **Don't accept untyped JSON.** Pydantic + max-length on every model — we got bit by huge payloads.
- **Don't `dangerouslySetInnerHTML` raw markdown output.** Sanitize first.
- **Don't interpolate user values into shell commands** (looking at you, `pipe-pane`). Validate or escape.
- **Don't `os.path.join(root, user_path)` and call it done.** Resolve and re-check `is_relative_to(root)` to block `..`.
- **Don't authenticate only the WS handshake URL.** Verify the cookie on every upgrade.
- **Don't keep silent `except:` blocks.** Use the structured logger.
- **Don't serve static files without containing the resolved path.** `serve_spa` in `main.py` joins the URL onto `dist/`; without `resolve()` + `is_relative_to(dist)` a `/..%2f..%2fetc/passwd` reads arbitrary files **unauthenticated** (this route has no auth dep). Was a live CRITICAL bug — fixed. Mirror the file API's `_safe_path`.
- **Don't bind the backend to `0.0.0.0`.** nginx (same host) is the only ingress; loopback bind (`AGENTBOARD_HOST`, default `127.0.0.1`) keeps `:3002` off the network so nothing bypasses the proxy. Remote agents come in via nginx→`/agent-ws`, not direct.
- **Don't let the default password (`changeme`) boot a real server.** The token is a deterministic hash of it → auth bypass. `main.py` raises unless `AGENTBOARD_ALLOW_DEFAULT_PW=1`.
- **Check who started a state-changing request, not just the cookie.** Every `*.<tailnet>.ts.net` node is one *site*, so the `SameSite=Lax` cookie rides along from a course site or board page served there; with only a cookie check, a script on such a page could open `/ws` and type into a terminal, or POST `/api/upload`. `auth.OriginGuard` refuses unsafe methods and WebSockets whose `Sec-Fetch-Site` isn't `same-origin` (Origin vs forwarded host when the header is missing: the desktop relay). GETs stay open — another site can't read their responses.
- **Use `hmac.compare_digest` for every token/cookie compare** (`auth.py`, login, `agent_ws`). Plain `==` is timing-variable.

### Multi-machine (Hub + Agent)
- **Don't run streamer/tmux on the hub for a remote id.** The hub relays remote
  hosts; only the owning agent process touches that machine's tmux. The hub runs
  streamer/tmux *only* for `host="local"`.
- **Don't run an agent on the hub machine.** `host="local"` already covers it; a
  co-located agent would fight over the same tmux server and `/tmp` FIFOs.
- **Don't leak a bare id to the browser.** Every agent→browser frame must pass
  through `namespace.prefix_msg` (one call site in `agent_ws`), or a remote id
  collides with a local one.
- **Don't forget to demote the previous active host.** On session switch the hub
  sends `active:""` to the host that lost its last viewer, else it keeps polling
  at 80 ms forever (`ws._handle_active` / `_release_remote`).
- **Don't cap the agent WS frame size.** A 2000-line ANSI snapshot can exceed the
  `websockets` 1 MB default — the agent connects with `max_size=None`. Relay
  snapshots verbatim; never chunk them (shreds scrollback).
- **Don't bump session-id Pydantic limits back to 64.** Prefixed ids (`host:localId`)
  need `max_length=128` or remote commands 422.
- **Don't let agents talk plaintext.** `ws://` exposes the agent token (full remote
  shell). The agent refuses it unless `AGENT_INSECURE=1`.
- **Reject a re-registering host by evicting the stale conn, not with 4409.** A dropped
  TCP link lingers until uvicorn's ping timeout (~20-30 s); rejecting the reconnect
  blocks recovery that whole time. `agent_ws` closes the old ws and the old handler's
  `finally` no-ops via a conn-identity guard (`registry.get(host) is conn`).
- **Resume `active` on agent reconnect.** The agent starts with empty active state, so
  the hub replays `active` (with each viewer's `wsId`) for sessions in `_ws_remote` —
  else remote terminals silently drop to 2 s background polling after every blip.
- **Key remote `active` by the browser's `wsId`.** The agent tracks viewers per hub
  ws_id; without it, multiple browsers viewing one host collapse onto one poll slot.
- **Mirror remote titles + cap the mirror.** `AgentConn.titles` feeds late-joiner
  replay (`mirror_titles`); `MAX_SESSIONS_PER_HOST` bounds a rogue agent's memory use.
- **Never drop durable agent frames under backpressure.** The agent's send queue sheds
  oldest `screen` frames only; `spawned/removed/status/snapshot/...` must survive or the
  hub mirror desyncs (killed session stuck "running", lost scrollback).
- **Correlate remote spawns with `reqId`.** The browser can't use the REST reply's id
  (the agent assigns it); it matches the `spawned` event's echoed `reqId` — robust to
  concurrent spawns. Spawn failures surface via a `spawn-error` frame.

### Notifications (Web Push)
- **Hook pushes into `ws.broadcast`, not `streamer._detect_state`.** Broadcast is
  the one choke point both local *and* remote (agent-relayed) state changes pass
  through with correct prefixed ids. `push.maybe_push` inspects each frame.
- **Dedup per session or you spam.** `push._last_state` latches waiting/completed
  and resets on working/idle/running, so re-broadcasts don't re-notify.
- **The service worker must NOT cache app assets.** `sw.js` only renders push +
  handles clicks. Caching would serve stale JS — the app is cache-busted server-side.
- **iOS only delivers Web Push to an installed PWA.** Manifest + apple-touch-icon +
  "add to home screen" are required on iPhone; Android/desktop Chrome push in-tab.
- **`.vapid_private.pem` and `.push-subs.json` are secrets/state — gitignored.**
  The VAPID keypair is generated once on first run and must persist (regenerating
  invalidates every existing subscription).

### Out of scope (intentionally removed)
- **Server-side LaTeX rendering.** Heavy, error-prone, slow. Removed in `22238eb`. Use client-side KaTeX.
- **Playwright screenshot loops for visual verification.** User runs visual checks manually. Don't add automated UI screenshot tests — see feedback memory.

### Deployment
- **Don't `sleep` to wait for the server.** Poll `/api/health`. Failed health = exit non-zero from `deploy.sh`.
- **Don't run a plain `npm run build` to check a change.** `frontend/dist` is what the live server serves, and Vite empties it first — that ships unreleased JS and deletes the hashed chunks open tabs still lazy-load. Build to a scratch dir (`npm run build -- --outDir <tmp>`); only `deploy.sh` publishes (it stages, keeps old assets, swaps `index.html` last).
- **Don't keep nested `v2/`, `v3/` folders.** Repo is now AgentBoard-only at the root. The `/root/TermHub/` directory still exists on the dev box for the legacy `.env` location, but it's not part of this repo.
- **Don't commit `*.png` debug screenshots, `server.log`, `.session-titles.json`, `node_modules/`, or `yarn.lock`.** All gitignored — keep them so.

## Environment

- `.env` load order (first-found wins, see `backend/config.py`): `<repo>/.env` (documented location) → `/workspace/.env` (legacy nested) → `/root/TermHub/.env` (legacy dev box — this box uses it). Keys: `DASHBOARD_PASSWORD`, `AGENTBOARD_PORT` (or legacy `V3_PORT`)
  - `AGENTBOARD_STATE_DIR` — where mutable state lives (`.session-titles.json`, `.push-subs.json`, `.vapid_private.pem`, `.spawn-profiles.json`); defaults to the repo root, containers point it at a volume. `AGENTBOARD_DEFAULT_CMD` — overrides `config.json`'s `defaultCommand` (Docker sets `bash`; `claude` isn't in the image).
  - Docker: `Dockerfile` (multi-stage: node build → python3.12-slim + tmux) + `docker-compose.yml` (binds `0.0.0.0` inside, port mapping is the boundary; `/workspace` mount; `agentboard-state` volume). CI (`.github/workflows/ci.yml`) builds the image and boot-smoke-tests both bare and containerized servers on every push.
  - Multi-machine / security knobs: `AGENT_TOKEN` (remote-agent secret; defaults to `AUTH_TOKEN`), `AGENTBOARD_HOST` (bind addr, default `127.0.0.1`), `AGENTBOARD_COOKIE_SECURE=1` (HTTPS-only cookie), `AGENTBOARD_ALLOW_DEFAULT_PW=1` (allow the `changeme` default — dev only; the server otherwise refuses to start)
  - Terminal knobs: `AGENTBOARD_NO_ALT_SCREEN` (default `1`) — sets tmux `alternate-screen off` globally (on spawn + recover), so full-screen apps (Claude Code, vim, less) render into the normal buffer and xterm gets real scrollback; set to `0` to restore native alt-screen behavior. Panes already inside an alt-screen are auto-unstuck by the streamer at their app's next exit (window-local override — see Pitfalls). `AGENTBOARD_HISTORY_LIMIT` (default `50000`) — tmux scrollback depth for new panes (tmux's own default 2000 fills in minutes). `AGENTBOARD_SNAPSHOT_MIN_INTERVAL` (default `0.5`) — min seconds between history-growth re-snapshots.
- nginx config: `/etc/nginx/gateway.d/port_12019.conf` → proxy to `:3002` (backend binds loopback only; nginx is the sole ingress)
- Python venv: `backend/.venv` (Python 3.12 via conda)
- Node: system node with npm
- Process manager: supervisord (`agentboard` program), falls back to `nohup` in `deploy.sh`

## API Reference

### REST
- `POST /api/login` — `{pw}` → cookie
- `GET  /api/workers` — session list (local sessions only; remote arrive via WS mirror)
- `GET  /api/hosts` — machines available for spawn (`local` + connected agents)
- `POST /api/spawn` — `{cwd, cmd, host}` (host defaults to `local`)
- `POST /api/kill` — `{id}` (id may be `host:localId` for a remote session)
- `POST /api/remove` — `{id}`
- `POST /api/input` — `{id, text}`
- `POST /api/key` — `{id, key}`
- `GET  /api/browse?path=` — directory listing
- `GET  /api/files?path=` — file listing with metadata
- `GET  /api/file?path=` — read file
- `GET  /api/preview-base?path=` — `{prefix, dir, root}`: the signed address of an HTML page's project files
- `GET  /api/preview/{token}/{path}` — a file of that project (no cookie; the token grants it)
- `GET  /api/quarto-freeze?path=` — `{markdown, folder, results}`: the outputs a Quarto document's last run saved
- `GET  /api/file-stat?path=` — `{signature}` (mtime:size:inode) — cheap change poll for every open file
- `POST /api/file` — `{path, content}` write file
- `GET  /api/push/key` — VAPID public key (applicationServerKey)
- `POST /api/push/subscribe` — `{endpoint, keys, expirationTime}` store a browser push subscription
- `POST /api/push/unsubscribe` — `{endpoint}`
- `GET  /api/capture?id=` — full scrollback of a local session as plain text (for "전체 로그"; remote returns an error)
- `GET  /api/health` — readiness probe (used by `deploy.sh`)

### WebSocket (`/ws`)
- Client → server: `resize`, `active`, `resync`, `viewport`, `viewport-release`, `desktop-width`, `title`, `key`, `terminal-input`, `input`
- Server → client: `spawned`, `snapshot`, `screen`, `stream`, `status`, `removed`, `cwd`, `aiState`, `info`, `title`, `titles` (remote msgs also carry `host`/`hostLabel`)

### WebSocket (`/agent-ws`) — remote agents only
- Agent → hub: `register` (first frame, `{token, host, label}`), then the same events
  as Server → client above (bare local ids), plus `pong`
- Hub → agent: `register-ack`, the same commands as Client → server above (bare ids),
  plus `spawn`/`kill`/`remove`, `ping`

## Repo state (April 2026)

- GitHub: `https://github.com/ralbu85/AgentBoard.git`
- Default branch: `main` (renamed from `ui-revamp` during cleanup)
- Single source of truth: this directory. Old `v2/`, `v3/`, and stale feature branches were removed from the remote.
- The `/root/TermHub/` directory on the dev box is a stale local clone with the old monorepo layout — **don't push from there**, only this directory pushes.
