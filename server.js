require("dotenv").config();
const http = require("http");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const sessions = new Map();
const workers = new Map();
let nextId = 1;
let tunnelUrl = null;
let tunnelProcess = null;

function createToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isAlive(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName}`, { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

function tmux(cmd) {
  try { return execSync("tmux " + cmd, { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { return ""; }
}

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function spawnWorker(cwd, cmd) {
  const config = loadConfig();
  cmd = cmd || config.defaultCommand || "claude";
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}" -e CLAUDECODE= -e TMUX=`);
  tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
  const logs = [];
  workers.set(id, { sessionName, cwd, cmd, logs });
  const pollTimer = setInterval(() => pollOutput(id), 1000);
  workers.get(id).pollTimer = pollTimer;
  broadcast({ type: "spawned", id, cwd, cmd, status: "running", sessionName });
  return id;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function detectWaiting(output) {
  const lines = output.split("\n");
  const recent = stripAnsi(lines.slice(-10).join("\n"));
  // Common permission/decision patterns across AI CLIs
  if (/Esc to cancel/.test(recent)) return true;
  if (/Do you want to proceed\?/.test(recent)) return true;
  if (/❯\s*\d+\.\s*(Yes|No)/.test(recent)) return true;
  if (/Allow/.test(recent) && /\?/.test(recent)) return true;
  if (/\([Yy]\/[Nn]\)/.test(recent) || /\[[Yy]\/[Nn]\]/.test(recent) || /\[[yY]\/[nN]\]/.test(recent)) return true;
  if (/approve|confirm|accept/i.test(recent) && /\?/.test(recent)) return true;
  return false;
}

const IDLE_THRESHOLD = 5000; // 5 seconds of no output change → idle

let lastCapture = {};
let lastLines = {};  // id → string[] for line-level diffing

function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;
  if (!isAlive(w.sessionName)) {
    clearInterval(w.pollTimer);
    w.status = 'completed';
    w.aiState = null;
    broadcast({ type: "status", id, status: "completed" });
    return;
  }
  const cols = w.cols || 80;
  const rows = w.rows || 50;
  tmux(`resize-window -t ${w.sessionName} -x ${cols} -y ${rows}`);
  const output = tmux(`capture-pane -t ${w.sessionName} -p -e -S -500 -J`);

  // Track actual working directory
  const currentCwd = tmux(`display-message -t ${w.sessionName} -p "#{pane_current_path}"`).trim();
  if (currentCwd && currentCwd !== w.cwd) {
    w.cwd = currentCwd;
    broadcast({ type: "cwd", id, cwd: currentCwd });
  }

  if (output === lastCapture[id]) {
    // Output unchanged — check if idle threshold reached
    if (w.aiState !== 'idle' && w.aiState !== 'waiting' && w.lastChangeTime) {
      const elapsed = Date.now() - w.lastChangeTime;
      if (elapsed >= IDLE_THRESHOLD) {
        const waiting = detectWaiting(output);
        const newState = waiting ? 'waiting' : 'idle';
        if (newState !== w.aiState) {
          w.aiState = newState;
          broadcast({ type: "aiState", id, state: newState });
        }
      }
    }
    return;
  }

  lastCapture[id] = output;
  w.lastChangeTime = Date.now();
  const lines = output.split("\n");
  w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));

  // Send delta instead of full snapshot
  const prev = lastLines[id];
  if (!prev) {
    broadcast({ type: "snapshot", id, lines });
  } else {
    const changed = {};
    const maxLen = Math.max(lines.length, prev.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= prev.length || i >= lines.length || lines[i] !== prev[i]) {
        changed[i] = i < lines.length ? lines[i] : null;
      }
    }
    broadcast({ type: "delta", id, len: lines.length, changed });
  }
  lastLines[id] = lines;

  // Output just changed — check for waiting, otherwise working
  const waiting = detectWaiting(output);
  const aiState = waiting ? 'waiting' : 'working';
  if (aiState !== w.aiState) {
    w.aiState = aiState;
    broadcast({ type: "aiState", id, state: aiState });
  }
}

function pausePoll(id) {
  const w = workers.get(id);
  if (w && w.pollTimer) { clearInterval(w.pollTimer); w.pollTimer = null; }
}

function resumePoll(id, delay) {
  const w = workers.get(id);
  if (w && !w.pollTimer) {
    w.pollTimer = setInterval(() => pollOutput(id), 1000);
    if (delay) setTimeout(() => pollOutput(id), delay);
  }
}

function sendInput(id, text) {
  const w = workers.get(id);
  if (!w) return false;
  pausePoll(id);
  const lines = text.split("\n");
  for (const line of lines) {
    tmux(`send-keys -t ${w.sessionName} "${line.replace(/"/g, '\\"')}" ""`);
    tmux(`send-keys -t ${w.sessionName} "" Enter`);
  }
  broadcast({ type: "log", id, src: "stdin", text, ts: Date.now() });
  resumePoll(id, 100);
  return true;
}

function killWorker(id) {
  const w = workers.get(id);
  if (!w) return false;
  clearInterval(w.pollTimer);
  tmux(`kill-session -t ${w.sessionName}`);
  w.status = 'stopped';
  w.aiState = null;
  broadcast({ type: "status", id, status: "stopped" });
  return true;
}

let wss;
function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function readBody(req) {
  return new Promise(res => {
    let buf = "";
    req.on("data", c => (buf += c));
    req.on("end", () => res(buf));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function auth(req) {
  const cookie = req.headers.cookie || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
  return token && sessions.has(token);
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url.split("?")[0];

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (method === "POST" && url === "/api/login") {
    const body = JSON.parse(await readBody(req));
    if (body.pw === PASSWORD) {
      const token = createToken();
      sessions.set(token, true);
      res.writeHead(200, { "Set-Cookie": `token=${token}; Path=/; HttpOnly`, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    return json(res, 401, { ok: false });
  }

  if (method === "GET" && url === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const MIME = { ".css": "text/css", ".js": "application/javascript" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    if (filePath.startsWith(path.join(__dirname, "public")) && fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (method === "GET" && url === "/api/config") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    const configPath = path.join(__dirname, "config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    return json(res, 200, config);
  }

  if (!auth(req)) return json(res, 401, { error: "unauthorized" });

  if (method === "GET" && url === "/api/workers") {
    const list = [...workers.entries()].map(([id, w]) => ({
      id, cwd: w.cwd, cmd: w.cmd || "claude", status: isAlive(w.sessionName) ? "running" : (w.status || "stopped"), sessionName: w.sessionName, logs: w.logs, aiState: w.aiState || null
    }));
    return json(res, 200, list);
  }

  if (method === "GET" && url === "/api/scan") {
    const raw = tmux("ls -F '#{session_name}|#{pane_current_path}'");
    const existingNames = new Set([...workers.values()].map(w => w.sessionName));
    const found = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const [sessionName, cwd] = line.split("|");
      if (existingNames.has(sessionName)) continue;
      found.push({ sessionName, cwd: cwd || "unknown" });
    }
    return json(res, 200, found);
  }

  if (method === "POST" && url === "/api/attach") {
    const { sessionName, cwd } = JSON.parse(await readBody(req));
    const id = String(nextId++);
    workers.set(id, { sessionName, cwd, logs: [] });
    const pollTimer = setInterval(() => pollOutput(id), 1000);
    workers.get(id).pollTimer = pollTimer;
    broadcast({ type: "spawned", id, cwd, status: "running", sessionName });
    return json(res, 200, { id });
  }

  if (method === "POST" && url === "/api/spawn") {
    const body = JSON.parse(await readBody(req));
    const rawCwd = body.cwd || process.cwd();
    const resolvedCwd = path.resolve(rawCwd);
    try {
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        return json(res, 400, { ok: false, error: "Invalid path: not a directory." });
      }
    } catch (e) {
      return json(res, 400, { ok: false, error: "Invalid path: does not exist or not accessible." });
    }
    const id = spawnWorker(resolvedCwd, body.cmd);
    return json(res, 200, { ok: true, id });
  }

  if (method === "POST" && url === "/api/input") {
    const { id, text } = JSON.parse(await readBody(req));
    const ok = sendInput(id, text);
    return json(res, 200, { ok });
  }

  if (method === "POST" && url === "/api/remove") {
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (w) { clearInterval(w.pollTimer); workers.delete(id); }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { id, key } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (w) tmux(`send-keys -t ${w.sessionName} ${key}`);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/reconnect") {
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    if (isAlive(w.sessionName)) {
      clearInterval(w.pollTimer);
      w.pollTimer = setInterval(() => pollOutput(id), 1000);
      broadcast({ type: "status", id, status: "running" });
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false });
  }

  if (method === "GET" && url === "/api/tunnel") {
    return json(res, 200, { url: tunnelUrl });
  }

  if (method === "POST" && url === "/api/kill") {
    const { id } = JSON.parse(await readBody(req));
    killWorker(id);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
});

wss = new WebSocketServer({ server });
const clientSizes = new Map();
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size) workers.forEach(w => { w.cols = size.cols; w.rows = size.rows; });
      }
      if (msg.type === 'key') {
        const w = workers.get(msg.id);
        if (w) {
          pausePoll(msg.id);
          tmux(`send-keys -t ${w.sessionName} ${msg.key}`);
          resumePoll(msg.id, 100);
        }
      }
      if (msg.type === 'input') {
        const w = workers.get(msg.id);
        if (w) {
          pausePoll(msg.id);
          const lines = msg.text.split("\n");
          for (const line of lines) {
            tmux(`send-keys -t ${w.sessionName} "${line.replace(/"/g, '\\"')}" ""`);
            tmux(`send-keys -t ${w.sessionName} "" Enter`);
          }
          broadcast({ type: "log", id: msg.id, src: "stdin", text: msg.text, ts: Date.now() });
          resumePoll(msg.id, 100);
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => clientSizes.delete(ws));
});


function recoverSessions() {
  const raw = tmux("ls -F '#{session_name}|#{pane_current_path}|#{pane_current_command}'");
  if (!raw.trim()) return;
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    const sessionName = parts[0];
    const cwd = parts[1] || "unknown";
    const cmd = parts[2] || "unknown";
    if (!sessionName.startsWith("term-")) continue;
    const id = sessionName.replace("term-", "");
    const numId = parseInt(id);
    if (isNaN(numId)) continue;
    if (workers.has(id)) continue;
    workers.set(id, { sessionName, cwd, cmd, logs: [] });
    const pollTimer = setInterval(() => pollOutput(id), 1000);
    workers.get(id).pollTimer = pollTimer;
    if (numId >= nextId) nextId = numId + 1;
  }
  if (workers.size > 0) {
    console.log(`♻️  Recovered ${workers.size} session(s)`);
  }
}

function startTunnel() {
  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log("☁️  cloudflared not found — skipping tunnel");
    return;
  }
  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handleData = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      console.log(`☁️  Tunnel URL → ${tunnelUrl}`);
      broadcast({ type: "tunnel", url: tunnelUrl });
      if (DISCORD_WEBHOOK) {
        fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `☁️ TermHub → ${tunnelUrl}` }),
        }).catch(() => {});
      }
    }
  };
  tunnelProcess.stdout.on("data", handleData);
  tunnelProcess.stderr.on("data", handleData);
  tunnelProcess.on("close", (code) => {
    console.log(`☁️  cloudflared exited (code ${code}), restarting in 5s...`);
    tunnelUrl = null;
    tunnelProcess = null;
    setTimeout(startTunnel, 5000);
  });
}

function checkTunnel() {
  if (!tunnelUrl) return;
  fetch(tunnelUrl, { signal: AbortSignal.timeout(10000) })
    .then(r => { if (!r.ok) throw new Error(r.status); })
    .catch(() => {
      console.log("☁️  Tunnel health check failed, restarting...");
      if (tunnelProcess) tunnelProcess.kill();
    });
}

server.listen(PORT, () => {
  recoverSessions();
  console.log(`✅ TermHub running → http://localhost:${PORT}`);
  console.log(`🔑 Password: ${PASSWORD}`);
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  startTunnel();
  setInterval(checkTunnel, 60000);
});

process.on("SIGINT", () => {
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});
process.on("SIGTERM", () => {
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});
