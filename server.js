require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { tmux, tmuxAsyncRaw } = require("./server/tmux");
const { workers, setBroadcast, setActiveSession, spawnWorker, killWorker, sendInput, pollOutput, pollAll, recoverSessions, lastCapture, sessionTitles, saveSessionTitles } = require("./server/workers");
const { setupRoutes } = require("./server/routes");
const tunnel = require("./server/tunnel");

// ── Config ──

const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const AUTH_TOKEN = crypto.createHmac("sha256", "termhub").update(PASSWORD).digest("hex");

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function auth(req) {
  const cookie = req.headers.cookie || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
  return token === AUTH_TOKEN;
}

// ── Server ──

const server = http.createServer();
let wss;

function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Wire up broadcast to modules
setBroadcast(broadcast);
tunnel.setBroadcast(broadcast);

// Setup HTTP routes
setupRoutes(server, { auth, broadcast, PASSWORD, AUTH_TOKEN, loadConfig });

// ── WebSocket ──

wss = new WebSocketServer({ server });
const clientSizes = new Map();

wss.on('connection', ws => {
  // Send full snapshots for all active workers
  workers.forEach((w, id) => {
    if (lastCapture[id]) {
      const lines = lastCapture[id].split("\n");
      ws.send(JSON.stringify({ type: "snapshot", id, lines }));
    }
  });

  // Send all session titles
  if (Object.keys(sessionTitles).length > 0) {
    ws.send(JSON.stringify({ type: "titles", titles: sessionTitles }));
  }

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
        setActiveSession(msg.id || null);
        const size = clientSizes.get(ws);
        if (msg.id) {
          const w = workers.get(msg.id);
          if (w && size) { w.cols = size.cols; w.rows = size.rows; }
          pollOutput(msg.id).catch(() => {});
        } else if (size) {
          workers.forEach(w => { w.cols = size.cols; w.rows = size.rows; });
        }
      }

      if (msg.type === 'resync') {
        if (msg.id && lastCapture[msg.id]) {
          const lines = lastCapture[msg.id].split("\n");
          ws.send(JSON.stringify({ type: "snapshot", id: msg.id, lines }));
        }
      }

      if (msg.type === 'title') {
        if (msg.id) {
          if (msg.title) {
            sessionTitles[msg.id] = msg.title;
          } else {
            delete sessionTitles[msg.id];
          }
          saveSessionTitles();
          broadcast({ type: "title", id: msg.id, title: msg.title || null });
        }
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

// ── Start ──

server.listen(PORT, () => {
  recoverSessions();
  pollAll();
  console.log(`✅ AgentBoard running → http://localhost:${PORT}`);
  console.log(`🔑 Password: ${PASSWORD}`);
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  tunnel.startTunnel(PORT, DISCORD_WEBHOOK);
  setInterval(() => tunnel.checkTunnel(), 60000);
});

process.on("SIGINT", () => { tunnel.cleanup(); process.exit(); });
process.on("SIGTERM", () => { tunnel.cleanup(); process.exit(); });
