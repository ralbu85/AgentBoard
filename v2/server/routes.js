const fs = require("fs");
const path = require("path");
const { isAlive, tmux } = require("./tmux");
const { sessions, getNextId, setNextId, spawnSession, killSession, sendInput } = require("./sessions");

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
      const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    const MIME = { ".css": "text/css", ".js": "application/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
    const ext = path.extname(url);
    if (method === "GET" && MIME[ext]) {
      const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, "..", "public", safePath);
      if (filePath.startsWith(path.join(__dirname, "..", "public")) && fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath);
        // gzip if client supports it and file is text
        const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
        if (acceptGzip && (ext === '.js' || ext === '.css')) {
          const zlib = require('zlib');
          const compressed = zlib.gzipSync(raw);
          res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "public, max-age=3600" });
          return res.end(compressed);
        }
        res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        return res.end(raw);
      }
    }

    // Config (needs auth)
    if (method === "GET" && url === "/api/config") {
      if (!auth(req)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, loadConfig());
    }

    // Auth wall
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });

    // ── Session API ──

    if (method === "GET" && url === "/api/workers") {
      const list = [...sessions.entries()].map(([id, s]) => {
        const alive = isAlive(s.sessionName);
        let status = alive ? "running" : (s.status || "stopped");
        if (alive && s.aiState === 'idle') status = 'running';
        return {
          id, cwd: s.cwd, cmd: s.cmd || "claude",
          status, sessionName: s.sessionName,
          aiState: s.aiState || null, process: s.process || null,
          createdAt: s.createdAt || null, memKB: s.memKB || 0
        };
      });
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
      const id = spawnSession(resolvedCwd, body.cmd);
      return json(res, 200, { ok: true, id });
    }

    if (method === "POST" && url === "/api/input") {
      const { id, text } = JSON.parse(await readBody(req));
      const ok = await sendInput(id, text);
      return json(res, 200, { ok });
    }

    if (method === "POST" && url === "/api/kill") {
      const { id } = JSON.parse(await readBody(req));
      killSession(id);
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/api/remove") {
      const { id } = JSON.parse(await readBody(req));
      sessions.delete(id);
      // Stream cleanup handled by streamer via session events
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/api/key") {
      const { id, key } = JSON.parse(await readBody(req));
      const s = sessions.get(id);
      if (s) tmux(`send-keys -t ${s.sessionName} ${key}`);
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/api/reconnect") {
      const { id } = JSON.parse(await readBody(req));
      const s = sessions.get(id);
      if (!s) return json(res, 404, { ok: false });
      if (isAlive(s.sessionName)) {
        s.status = 'running';
        broadcast({ type: "status", id, status: "running" });
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: false });
    }

    if (method === "POST" && url === "/api/attach") {
      const { sessionName, cwd } = JSON.parse(await readBody(req));
      const id = String(getNextId());
      setNextId(getNextId() + 1);
      sessions.set(id, { sessionName, cwd, cols: 80, rows: 24, status: 'running', aiState: 'working' });
      broadcast({ type: "spawned", id, cwd, status: "running", sessionName });
      return json(res, 200, { id });
    }

    if (method === "GET" && url === "/api/scan") {
      const raw = tmux("ls -F '#{session_name}|#{pane_current_path}'");
      const existingNames = new Set([...sessions.values()].map(s => s.sessionName));
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
      const mimeMap = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
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
      const s = dir ? null : sessions.get(id);
      if (!s && !dir) return json(res, 404, { error: "session not found" });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const safeName = path.basename(filename);
      const dest = path.join(dir || s.cwd, safeName);
      fs.writeFileSync(dest, buf);
      return json(res, 200, { ok: true, path: dest, name: safeName });
    }

    if (method === "GET" && url === "/api/tunnel") {
      return json(res, 200, { url: null });
    }

    if (method === "POST" && url === "/api/perf") {
      const body = JSON.parse(await readBody(req));
      const fs = require('fs');
      const logFile = require('path').join(__dirname, '..', 'perf.log');
      const entry = '\n' + new Date().toISOString() +
        ' | ' + (body.mobile ? 'MOBILE' : 'DESKTOP') +
        ' | ' + body.screen +
        ' | ' + (body.userAgent || '').slice(0, 60) + '\n' +
        (body.marks || []).map(m => '  +' + m.t + 'ms\t' + m.name + (m.detail ? '\t' + m.detail : '')).join('\n') + '\n';
      fs.appendFileSync(logFile, entry);
      console.log('[perf] Client report received (' + (body.mobile ? 'mobile' : 'desktop') + ')');
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  });
}

module.exports = { setupRoutes };
