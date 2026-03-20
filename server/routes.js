const fs = require("fs");
const path = require("path");
const { isAlive, tmux } = require("./tmux");
const { workers, getNextId, setNextId, spawnWorker, killWorker, sendInput, lastCapture } = require("./workers");

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

function setupRoutes(server, { auth, broadcast, PASSWORD, AUTH_TOKEN, loadConfig }) {
  server.on("request", async (req, res) => {
    const { method } = req;
    const url = req.url.split("?")[0];

    if (method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }

    // Login
    if (method === "POST" && url === "/api/login") {
      const body = JSON.parse(await readBody(req));
      if (body.pw === PASSWORD) {
        res.writeHead(200, { "Set-Cookie": `token=${AUTH_TOKEN}; Path=/; HttpOnly`, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 401, { ok: false });
    }

    // Static files
    if (method === "GET" && url === "/") {
      const html = fs.readFileSync(path.join(__dirname, "..", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    const MIME = { ".css": "text/css", ".js": "application/javascript" };
    const ext = path.extname(url);
    if (method === "GET" && MIME[ext]) {
      const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, "..", "public", safePath);
      if (filePath.startsWith(path.join(__dirname, "..", "public")) && fs.existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" });
        return res.end(fs.readFileSync(filePath));
      }
    }

    // Config (no auth needed)
    if (method === "GET" && url === "/api/config") {
      if (!auth(req)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, loadConfig());
    }

    // Auth wall
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });

    // ── Worker API ──

    if (method === "GET" && url === "/api/workers") {
      const list = [...workers.entries()].map(([id, w]) => ({
        id, cwd: w.cwd, cmd: w.cmd || "claude",
        status: isAlive(w.sessionName) ? "running" : (w.status || "stopped"),
        sessionName: w.sessionName, logs: w.logs,
        aiState: w.aiState || null, process: w.process || null,
        createdAt: w.createdAt || null, memKB: w.memKB || 0
      }));
      return json(res, 200, list);
    }

    if (method === "POST" && url === "/api/spawn") {
      const body = JSON.parse(await readBody(req));
      const rawCwd = body.cwd || process.cwd();
      const resolvedCwd = path.resolve(rawCwd);
      try {
        const stat = fs.statSync(resolvedCwd);
        if (!stat.isDirectory()) return json(res, 400, { ok: false, error: "Invalid path: not a directory." });
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

    if (method === "POST" && url === "/api/kill") {
      const { id } = JSON.parse(await readBody(req));
      killWorker(id);
      return json(res, 200, { ok: true });
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

    if (method === "POST" && url === "/api/attach") {
      const { sessionName, cwd } = JSON.parse(await readBody(req));
      const id = String(getNextId());
      setNextId(getNextId() + 1);
      workers.set(id, { sessionName, cwd, logs: [] });
      broadcast({ type: "spawned", id, cwd, status: "running", sessionName });
      return json(res, 200, { id });
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

    // ── File API ──

    if (method === "GET" && url.startsWith("/api/browse")) {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const resolved = path.resolve(params.get("path") || "/");
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
        return json(res, 200, { path: resolved, dirs });
      } catch (e) {
        return json(res, 400, { error: "Cannot read directory" });
      }
    }

    if (method === "GET" && url.startsWith("/api/files")) {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const resolved = path.resolve(params.get("path") || "/");
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const items = entries.map(e => {
          try {
            const st = fs.statSync(path.join(resolved, e.name));
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
          } catch { return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 }; }
        }).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
        return json(res, 200, { path: resolved, entries: items });
      } catch (e) {
        return json(res, 400, { error: "Cannot read directory" });
      }
    }

    if (method === "GET" && url.startsWith("/api/file-raw")) {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const filePath = path.resolve(params.get("path") || "");
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
      try {
        const st = fs.statSync(filePath);
        res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Length": st.size });
        fs.createReadStream(filePath).pipe(res);
        return;
      } catch (e) {
        return json(res, 400, { error: "Cannot read file" });
      }
    }

    if (method === "GET" && url.startsWith("/api/file") && !url.startsWith("/api/files") && !url.startsWith("/api/file-raw")) {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const filePath = path.resolve(params.get("path") || "");
      try {
        const st = fs.statSync(filePath);
        if (st.size > 10 * 1024 * 1024) return json(res, 400, { error: "File too large (>10MB)" });
        const binExts = ['.pdf','.png','.jpg','.jpeg','.gif','.zip','.tar','.gz','.bin','.exe','.dll','.so','.o','.pyc','.woff','.woff2','.ttf','.ico','.mp3','.mp4','.mov','.avi'];
        if (binExts.includes(path.extname(filePath).toLowerCase())) return json(res, 400, { error: "Binary file — use file-raw endpoint" });
        const content = fs.readFileSync(filePath, "utf8");
        return json(res, 200, { path: filePath, content, size: st.size });
      } catch (e) {
        return json(res, 400, { error: "Cannot read file" });
      }
    }

    if (method === "POST" && url === "/api/file") {
      const { path: filePath, content } = JSON.parse(await readBody(req));
      try {
        fs.writeFileSync(path.resolve(filePath), content, "utf8");
        return json(res, 200, { ok: true, path: path.resolve(filePath) });
      } catch (e) {
        return json(res, 400, { error: "Cannot write file" });
      }
    }

    if (method === "POST" && url === "/api/rename") {
      const { from, to } = JSON.parse(await readBody(req));
      try {
        fs.renameSync(path.resolve(from), path.resolve(to));
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: "Cannot rename" });
      }
    }

    if (method === "POST" && url === "/api/delete") {
      const { path: filePath } = JSON.parse(await readBody(req));
      const resolved = path.resolve(filePath);
      try {
        const st = fs.statSync(resolved);
        if (st.isDirectory()) fs.rmSync(resolved, { recursive: true });
        else fs.unlinkSync(resolved);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: "Cannot delete" });
      }
    }

    if (method === "POST" && url === "/api/mkdir") {
      const { path: dirPath } = JSON.parse(await readBody(req));
      try {
        fs.mkdirSync(path.resolve(dirPath), { recursive: true });
        return json(res, 200, { ok: true, path: path.resolve(dirPath) });
      } catch (e) {
        return json(res, 400, { error: "Cannot create directory" });
      }
    }

    if (method === "POST" && url === "/api/upload") {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const id = params.get("id");
      const filename = params.get("name") || ("paste-" + Date.now() + ".png");
      const dir = params.get("dir");
      const w = dir ? null : workers.get(id);
      if (!w && !dir) return json(res, 404, { error: "worker not found" });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const safeName = path.basename(filename);
      const dest = path.join(dir || w.cwd, safeName);
      fs.writeFileSync(dest, buf);
      return json(res, 200, { ok: true, path: dest, name: safeName });
    }

    if (method === "GET" && url === "/api/tunnel") {
      return json(res, 200, { url: null }); // tunnel URL injected externally
    }

    json(res, 404, { error: "not found" });
  });
}

module.exports = { setupRoutes };
