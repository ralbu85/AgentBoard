const { execFile } = require("child_process");
const { tmuxAsyncRaw } = require("./tmux");
const { sessions, detectState } = require("./sessions");

const POLL_FAST = 500;
const POLL_SLOW = 5000;
const POLL_BASE = 300;

let broadcastFn = () => {};
let activeSessionId = null;
let lastCapture = {};

function setBroadcast(fn) { broadcastFn = fn; }
function setActiveSession(id) { activeSessionId = id; }
function getLastCapture() { return lastCapture; }

async function pollOutput(id) {
  const s = sessions.get(id);
  if (!s) return;

  const alive = await new Promise(resolve => {
    execFile("tmux", ["has-session", "-t", s.sessionName], (err) => resolve(!err));
  });
  if (!alive) {
    if (s.status !== 'stopped' && s.status !== 'completed') {
      s.status = 'completed';
      s.aiState = null;
      broadcastFn({ type: "status", id, status: "completed" });
    }
    return;
  }

  const cols = s.cols || 80;
  const rows = s.rows || 50;
  const captureStart = (id === activeSessionId) ? "-500" : "-50";

  // Resize FIRST, then capture — must be sequential so tmux
  // reflows content before we read it
  await tmuxAsyncRaw(["resize-window", "-t", s.sessionName, "-x", String(cols), "-y", String(rows)]);

  const [output, currentCwd] = await Promise.all([
    tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e", "-S", captureStart]),
    tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p", "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
  ]);

  const infoParts = currentCwd.trim().split("|");
  const trimmedCwd = infoParts[0] || "";
  const curProcess = infoParts[1] || "";
  const createdAt = parseInt(infoParts[2]) || 0;
  const panePid = infoParts[3] || "";

  if (trimmedCwd && trimmedCwd !== s.cwd) {
    s.cwd = trimmedCwd;
    broadcastFn({ type: "cwd", id, cwd: trimmedCwd });
  }

  // Memory tracking (every 30 polls)
  if (!s._memTick) s._memTick = 0;
  s._memTick++;
  let memKB = s.memKB || 0;
  if (panePid && s._memTick % 30 === 0) {
    try {
      const psOut = await new Promise(resolve => {
        execFile("ps", ["-o", "rss=", "--pid", panePid, "--ppid", panePid], { encoding: "utf8", timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout));
      });
      memKB = psOut.trim().split(/\s+/).reduce((sum, v) => sum + (parseInt(v) || 0), 0);
    } catch (e) { memKB = 0; }
  }

  if (curProcess !== s.process || createdAt !== s.createdAt || memKB !== s.memKB) {
    s.process = curProcess;
    s.createdAt = createdAt;
    s.memKB = memKB;
    broadcastFn({ type: "info", id, process: curProcess, createdAt, memKB });
  }

  const newAiState = detectState(output, curProcess);

  // Output unchanged — just update state if needed
  if (output === lastCapture[id]) {
    if (newAiState !== s.aiState) {
      s.aiState = newAiState;
      broadcastFn({ type: "aiState", id, state: newAiState });
    }
    return;
  }

  lastCapture[id] = output;
  s.lastChangeTime = Date.now();

  // Update server buffer — single source of truth
  const buffer = require('./buffer');
  const diff = buffer.update(id, output);

  if (diff) {
    if (diff.type === 'full') {
      broadcastFn({ type: "output-full", id, lines: diff.lines, version: diff.version });
    } else {
      broadcastFn({ type: "output-append", id, lines: diff.lines, version: diff.version });
    }
  }

  // Update AI state
  if (newAiState !== s.aiState) {
    s.aiState = newAiState;
    broadcastFn({ type: "aiState", id, state: newAiState });
  }
}

async function pollAll() {
  const now = Date.now();
  const ids = [...sessions.keys()];
  const toPoll = ids.filter(id => {
    const s = sessions.get(id);
    if (!s) return false;
    if (s.status === 'stopped') return false;
    // Active session always polls fast so timer/status updates are visible
    const isActive = (id === activeSessionId);
    const interval = isActive ? POLL_FAST
      : (s.aiState === 'idle' || s.aiState === 'waiting' || s.status === 'completed') ? POLL_SLOW
      : POLL_FAST;
    if (!s._lastPoll || now - s._lastPoll >= interval) {
      s._lastPoll = now;
      return true;
    }
    return false;
  });
  if (toPoll.length > 0) {
    await Promise.all(toPoll.map(id => pollOutput(id).catch(() => {})));
  }
  setTimeout(pollAll, POLL_BASE);
}

module.exports = { setBroadcast, setActiveSession, getLastCapture, pollOutput, pollAll, lastCapture };
