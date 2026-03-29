// ── WebSocket Connection + Message Routing ──

(function(AB) {

  var ws = null;
  var _resizeTimer = null;

  function init() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    if (AB._perfHookWs) AB._perfHookWs(ws);

    ws.onopen = function() {
      document.getElementById('status-dot').classList.remove('off');
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

    ws.onmessage = function(e) { handleMsg(JSON.parse(e.data)); };
  }

  function handleMsg(d) {
    var store = AB.store;

    if (d.type === 'spawned') store.add(d.id, { cwd: d.cwd, cmd: d.cmd, status: d.status, sessionName: d.sessionName });
    if (d.type === 'snapshot') AB.terminal.writeSnapshot(d.id, d.data);
    if (d.type === 'screen') AB.terminal.writeScreen(d.id, d.data);
    if (d.type === 'stream') AB.terminal.writeStream(d.id, d.data);
    if (d.type === 'status') store.updateStatus(d.id, d.status);
    if (d.type === 'cwd') store.updateCwd(d.id, d.cwd);
    if (d.type === 'aiState') store.updateAiState(d.id, d.state);
    if (d.type === 'info') store.updateInfo(d.id, d.process, d.createdAt, d.memKB);
    if (d.type === 'title') store.updateTitle(d.id, d.title);
    if (d.type === 'titles') {
      AB._customTitles = d.titles || {};
      Object.keys(AB._customTitles).forEach(function(id) { store.updateTitle(id, AB._customTitles[id]); });
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
        send({ type: 'resync', id: activeId });
      }
    }, 300);
  }

  function notifyActive(id) { send({ type: 'active', id: id || null }); }

  AB.ws = { init: init, send: send, sendResize: sendResize, notifyActive: notifyActive };

})(window.AB = window.AB || {});
