// ── Terminal Relay ──
// capture-pane polling with in-place overwrite (no scrollback pollution).
// Active session: 150ms poll → send only changed lines
// Background:     2s poll → state detection only
// Input:          send-keys (reliable, no PTY attach overhead)

const { execFile } = require("child_process");
const { tmuxAsyncRaw } = require("./tmux");
const { sessions, detectState } = require("./sessions");

let broadcastFn = () => {};
let activeSessionId = null;
const lastScreen = {};  // id → last captured output

const ACTIVE_POLL_MS = 150;
const BG_POLL_MS = 2000;

function setBroadcast(fn) { broadcastFn = fn; }
function setActiveSession(id) { activeSessionId = id; }

// ── Snapshot: full history for session switch ──

async function getSnapshot(id) {
  const s = sessions.get(id);
  if (!s) return null;

  const cols = s.cols || 80;
  const rows = s.rows || 50;

  const [, rawOutput, info] = await Promise.all([
    tmuxAsyncRaw(["resize-window", "-t", s.sessionName, "-x", String(cols), "-y", String(rows)]),
    tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e", "-S", "-2000"]),
    tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p",
      "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"])
  ]);

  _updateInfo(id, s, info);
  _detectState(id, s, rawOutput);
  lastScreen[id] = rawOutput;

  return rawOutput.replace(/\r?\n/g, '\r\n');
}

async function getScreenSnapshot(id) {
  const s = sessions.get(id);
  if (!s) return null;

  const rows = s.rows || 50;
  const rawOutput = await tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e", "-S", "-" + String(rows)]);
  lastScreen[id] = rawOutput;
  return rawOutput.replace(/\r?\n/g, '\r\n');
}

// ── Immediate poll after input ──

async function pollNow(id) {
  const s = sessions.get(id);
  if (!s || s.status === 'stopped' || s.status === 'completed') return;
  try {
    const output = await tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e"]);
    if (output !== lastScreen[id]) {
      lastScreen[id] = output;
      broadcastFn({
        type: 'screen', id,
        data: output.replace(/\r?\n/g, '\r\n')
      });
    }
  } catch (e) {}
}

// ── Active session polling ──

async function _pollActive() {
  if (activeSessionId) {
    const s = sessions.get(activeSessionId);
    if (s && s.status !== 'stopped' && s.status !== 'completed') {
      try {
        const output = await tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-e"]);

        if (output !== lastScreen[activeSessionId]) {
          lastScreen[activeSessionId] = output;
          // Send as screen update (in-place overwrite, no scrollback pollution)
          broadcastFn({
            type: 'screen',
            id: activeSessionId,
            data: output.replace(/\r?\n/g, '\r\n')
          });
        }
      } catch (e) {}
    }
  }
  setTimeout(_pollActive, ACTIVE_POLL_MS);
}

// ── Background polling: state + alive detection ──

async function pollStates() {
  for (const [id, s] of sessions.entries()) {
    if (s.status === 'stopped') continue;

    const alive = await new Promise(resolve => {
      execFile("tmux", ["has-session", "-t", s.sessionName], err => resolve(!err));
    });

    if (!alive) {
      if (s.status !== 'completed') {
        s.status = 'completed';
        s.aiState = null;
        broadcastFn({ type: "status", id, status: "completed" });
      }
      continue;
    }

    if (id === activeSessionId) continue;

    try {
      const [info, tail] = await Promise.all([
        tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p",
          "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
        tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-S", "-20"])
      ]);
      _updateInfo(id, s, info);
      _detectState(id, s, tail);
    } catch (e) {}
  }
  setTimeout(pollStates, BG_POLL_MS);
}

// ── Info polling for active session (less frequent) ──

async function _pollActiveInfo() {
  if (activeSessionId) {
    const s = sessions.get(activeSessionId);
    if (s && s.status !== 'stopped' && s.status !== 'completed') {
      try {
        const [info, tail] = await Promise.all([
          tmuxAsyncRaw(["display-message", "-t", s.sessionName, "-p",
            "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
          tmuxAsyncRaw(["capture-pane", "-t", s.sessionName, "-p", "-S", "-20"])
        ]);
        _updateInfo(activeSessionId, s, info);
        _detectState(activeSessionId, s, tail);
      } catch (e) {}
    }
  }
  setTimeout(_pollActiveInfo, 2000);
}

// ── Helpers ──

function _updateInfo(id, s, infoStr) {
  const parts = infoStr.trim().split("|");
  const cwd = parts[0] || "";
  const curProcess = parts[1] || "";
  const createdAt = parseInt(parts[2]) || 0;

  if (cwd && cwd !== s.cwd) {
    s.cwd = cwd;
    broadcastFn({ type: "cwd", id, cwd });
  }
  if (curProcess !== s.process || createdAt !== s.createdAt) {
    s.process = curProcess;
    s.createdAt = createdAt;
    broadcastFn({ type: "info", id, process: curProcess, createdAt, memKB: s.memKB || 0 });
  }
}

function _detectState(id, s, output) {
  const newState = detectState(output, s.process || "");
  if (newState !== s.aiState) {
    s.aiState = newState;
    broadcastFn({ type: "aiState", id, state: newState });
  }
}

// ── Lifecycle ──

function startPolling() {
  _pollActive();
  _pollActiveInfo();
  pollStates();
}

function stopAllStreams() {
  Object.keys(lastScreen).forEach(k => delete lastScreen[k]);
}

module.exports = {
  setBroadcast, setActiveSession,
  getSnapshot, getScreenSnapshot,
  pollNow, startPolling, pollStates, stopAllStreams
};
