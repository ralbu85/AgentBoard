require("dotenv").config();
const http = require("http");
const { execSync, execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const AUTH_TOKEN = crypto.createHmac("sha256", "termhub").update(PASSWORD).digest("hex");
const workers = new Map();
let nextId = 1;
let tunnelUrl = null;
let tunnelProcess = null;

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

function tmuxAsync(cmd) {
  return new Promise(resolve => {
    execFile("tmux", cmd.split(/\s+/), { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function tmuxAsyncRaw(args) {
  return new Promise(resolve => {
    execFile("tmux", args, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function spawnWorker(cwd, cmd) {
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}"`);
  if (cmd) {
    tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
  }
  const logs = [];
  workers.set(id, { sessionName, cwd, cmd, logs, cols: 80, rows: 24 });
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

async function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;

  const alive = await new Promise(resolve => {
    execFile("tmux", ["has-session", "-t", w.sessionName], (err) => resolve(!err));
  });
  if (!alive) {
    w.status = 'completed';
    w.aiState = null;
    broadcast({ type: "status", id, status: "completed" });
    return;
  }

  const cols = w.cols || 80;
  const rows = w.rows || 50;

  // Run resize, capture, and cwd in parallel — non-blocking
  const [, output, currentCwd] = await Promise.all([
    tmuxAsyncRaw(["resize-window", "-t", w.sessionName, "-x", String(cols), "-y", String(rows)]),
    tmuxAsyncRaw(["capture-pane", "-t", w.sessionName, "-p", "-e", "-S", "-500", "-J"]),
    tmuxAsyncRaw(["display-message", "-t", w.sessionName, "-p", "#{pane_current_path}|#{pane_current_command}|#{session_created}|#{pane_pid}"]),
  ]);

  const infoParts = currentCwd.trim().split("|");
  const trimmedCwd = infoParts[0] || "";
  const curProcess = infoParts[1] || "";
  const createdAt = parseInt(infoParts[2]) || 0;
  const panePid = infoParts[3] || "";

  if (trimmedCwd && trimmedCwd !== w.cwd) {
    w.cwd = trimmedCwd;
    broadcast({ type: "cwd", id, cwd: trimmedCwd });
  }

  // Memory check throttled to ~10s (every 30 polls at 300ms)
  if (!w._memTick) w._memTick = 0;
  w._memTick++;
  let memKB = w.memKB || 0;
  if (panePid && w._memTick % 30 === 0) {
    try {
      const psOut = await new Promise(resolve => {
        execFile("ps", ["-o", "rss=", "--pid", panePid, "--ppid", panePid], { encoding: "utf8", timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout));
      });
      memKB = psOut.trim().split(/\s+/).reduce((sum, v) => sum + (parseInt(v) || 0), 0);
    } catch (e) { memKB = 0; }
  }

  if (curProcess !== w.process || createdAt !== w.createdAt || memKB !== w.memKB) {
    w.process = curProcess;
    w.createdAt = createdAt;
    w.memKB = memKB;
    broadcast({ type: "info", id, process: curProcess, createdAt, memKB });
  }

  if (output === lastCapture[id]) {
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

  broadcast({ type: "snapshot", id, lines });

  const waiting = detectWaiting(output);
  const aiState = waiting ? 'waiting' : 'working';
  if (aiState !== w.aiState) {
    w.aiState = aiState;
    broadcast({ type: "aiState", id, state: aiState });
  }
}

// Single poll loop — polls all workers concurrently without blocking event loop
const POLL_INTERVAL = 300;
async function pollAll() {
  const ids = [...workers.keys()];
  await Promise.all(ids.map(id => pollOutput(id).catch(() => {})));
  setTimeout(pollAll, POLL_INTERVAL);
}

async function sendInput(id, text) {
  const w = workers.get(id);
  if (!w) return false;
  const lines = text.split("\n");
  for (const line of lines) {
    await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, line.replace(/"/g, '\\"'), ""]);
    await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, "", "Enter"]);
  }
  broadcast({ type: "log", id, src: "stdin", text, ts: Date.now() });
  setTimeout(() => pollOutput(id), 100);
  return true;
}

function killWorker(id) {
  const w = workers.get(id);
  if (!w) return false;
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
  return token === AUTH_TOKEN;
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
      res.writeHead(200, { "Set-Cookie": `token=${AUTH_TOKEN}; Path=/; HttpOnly`, "Content-Type": "application/json" });
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
      id, cwd: w.cwd, cmd: w.cmd || "claude", status: isAlive(w.sessionName) ? "running" : (w.status || "stopped"), sessionName: w.sessionName, logs: w.logs, aiState: w.aiState || null, process: w.process || null, createdAt: w.createdAt || null, memKB: w.memKB || 0
    }));
    return json(res, 200, list);
  }

  if (method === "GET" && url.startsWith("/api/browse")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const dir = params.get("path") || "/";
    const resolved = path.resolve(dir);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      return json(res, 200, { path: resolved, dirs });
    } catch (e) {
      return json(res, 400, { error: "Cannot read directory" });
    }
  }

  if (method === "GET" && url.startsWith("/api/files")) {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const dir = params.get("path") || "/";
    const resolved = path.resolve(dir);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => {
          try {
            const st = fs.statSync(path.join(resolved, e.name));
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
          } catch { return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 }; }
        })
        .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      return json(res, 200, { path: resolved, entries: items });
    } catch (e) {
      return json(res, 400, { error: "Cannot read directory" });
    }
  }

  if (method === "GET" && url.startsWith("/api/file")) {
    if (url.startsWith("/api/files")) {} // handled above
    else {
      const qs = req.url.split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const filePath = path.resolve(params.get("path") || "");
      try {
        const st = fs.statSync(filePath);
        if (st.size > 1024 * 1024) return json(res, 400, { error: "File too large (>1MB)" });
        const content = fs.readFileSync(filePath, "utf8");
        return json(res, 200, { path: filePath, content, size: st.size });
      } catch (e) {
        return json(res, 400, { error: "Cannot read file" });
      }
    }
  }

  if (method === "POST" && url === "/api/file") {
    const { path: filePath, content } = JSON.parse(await readBody(req));
    const resolved = path.resolve(filePath);
    try {
      fs.writeFileSync(resolved, content, "utf8");
      return json(res, 200, { ok: true, path: resolved });
    } catch (e) {
      return json(res, 400, { error: "Cannot write file" });
    }
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
    workers.delete(id);
    delete lastCapture[id];
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { id, key } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (w) tmux(`send-keys -t ${w.sessionName} ${key}`);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/upload") {
    const qs = req.url.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    const id = params.get("id");
    const filename = params.get("name") || ("paste-" + Date.now() + ".png");
    const w = workers.get(id);
    if (!w) return json(res, 404, { error: "worker not found" });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    const safeName = path.basename(filename);
    const dest = path.join(w.cwd, safeName);
    fs.writeFileSync(dest, buf);
    return json(res, 200, { ok: true, path: dest, name: safeName });
  }

  if (method === "POST" && url === "/api/reconnect") {
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    if (isAlive(w.sessionName)) {
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
  // Send full snapshots for all active workers so client has initial cache
  workers.forEach((w, id) => {
    if (lastCapture[id]) {
      const lines = lastCapture[id].split("\n");
      ws.send(JSON.stringify({ type: "snapshot", id, lines }));
    }
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
        if (msg.id) {
          const w = workers.get(msg.id);
          if (w) { w.cols = msg.cols; w.rows = msg.rows; }
        } else {
          workers.forEach(w => { w.cols = msg.cols; w.rows = msg.rows; });
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size) workers.forEach(w => { w.cols = size.cols; w.rows = size.rows; });
      }
      if (msg.type === 'key') {
        const w = workers.get(msg.id);
        if (w) {
          tmuxAsyncRaw(["send-keys", "-t", w.sessionName, msg.key]).then(() => {
            setTimeout(() => pollOutput(msg.id), 100);
          });
        }
      }
      if (msg.type === 'input') {
        const w = workers.get(msg.id);
        if (w) {
          (async () => {
            const lines = msg.text.split("\n");
            for (const line of lines) {
              await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, line.replace(/"/g, '\\"'), ""]);
              await tmuxAsyncRaw(["send-keys", "-t", w.sessionName, "", "Enter"]);
            }
            broadcast({ type: "log", id: msg.id, src: "stdin", text: msg.text, ts: Date.now() });
            setTimeout(() => pollOutput(msg.id), 100);
          })();
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
    workers.set(id, { sessionName, cwd, cmd, logs: [], cols: 80, rows: 24 });
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
  pollAll(); // Start single async poll loop for all workers
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
