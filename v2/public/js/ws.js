// ── WebSocket Connection + Message Routing ──
// No rendering — delegates to store and terminal.

(function(AB) {

  var ws = null;
  var _resizeTimer = null;

  function init() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);

    ws.onopen = function() {
      document.getElementById('status-dot').classList.remove('off');
      // Send resize for active session if already selected
      if (AB.store.activeId) {
        var size = AB.terminal.resize(AB.store.activeId);
        if (size && size.cols > 0 && size.rows > 0) {
          send({ type: 'resize', id: AB.store.activeId, cols: size.cols, rows: size.rows });
        }
        send({ type: 'active', id: AB.store.activeId });
      }
    };

    ws.onclose = function() {
      document.getElementById('status-dot').classList.add('off');
      setTimeout(init, 2000);
    };

    ws.onmessage = function(e) {
      handleMsg(JSON.parse(e.data));
    };
  }

  function handleMsg(d) {
    var store = AB.store;

    if (d.type === 'spawned') {
      store.add(d.id, { cwd: d.cwd, cmd: d.cmd, status: d.status, sessionName: d.sessionName });
    }

    if (d.type === 'output') {
      // Write raw output to xterm.js terminal
      AB.terminal.write(d.id, d.data);
    }

    if (d.type === 'log') {
      // stdin echo — could show as notification or ignore
      // xterm.js will show it when next poll arrives
    }

    if (d.type === 'status') {
      store.updateStatus(d.id, d.status);
    }

    if (d.type === 'cwd') {
      store.updateCwd(d.id, d.cwd);
    }

    if (d.type === 'aiState') {
      store.updateAiState(d.id, d.state);
    }

    if (d.type === 'info') {
      store.updateInfo(d.id, d.process, d.createdAt, d.memKB);
    }

    if (d.type === 'title') {
      store.updateTitle(d.id, d.title);
    }

    if (d.type === 'titles') {
      // Bulk title sync on connect
      AB._customTitles = d.titles || {};
      Object.keys(AB._customTitles).forEach(function(id) {
        store.updateTitle(id, AB._customTitles[id]);
      });
    }
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function() {
      var activeId = AB.store.activeId;
      if (!activeId) return;
      var size = AB.terminal.resize(activeId);
      if (size && size.cols > 0 && size.rows > 0) {
        send({ type: 'resize', id: activeId, cols: size.cols, rows: size.rows });
        var t = AB.terminal.get(activeId);
        if (t) t.lastData = null;
        send({ type: 'resync', id: activeId });
      }
    }, 300);
  }

  function notifyActive(id) {
    send({ type: 'active', id: id || null });
  }

  AB.ws = { init: init, send: send, sendResize: sendResize, notifyActive: notifyActive };

})(window.AB = window.AB || {});
