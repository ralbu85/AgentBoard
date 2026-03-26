// ── Performance Monitor ──
// Logs all timing data to console and sends to server for analysis

(function(AB) {

  var _perf = { start: Date.now(), marks: [] };

  function mark(name, detail) {
    var entry = { t: Date.now() - _perf.start, name: name };
    if (detail) entry.detail = detail;
    _perf.marks.push(entry);
    console.log('[perf] +' + entry.t + 'ms ' + name + (detail ? ' | ' + detail : ''));
  }

  // Page load timing
  window.addEventListener('load', function() {
    var nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      mark('page-load', 'dns=' + Math.round(nav.domainLookupEnd - nav.domainLookupStart) + 'ms' +
        ' tcp=' + Math.round(nav.connectEnd - nav.connectStart) + 'ms' +
        ' ttfb=' + Math.round(nav.responseStart - nav.requestStart) + 'ms' +
        ' dom=' + Math.round(nav.domContentLoadedEventEnd - nav.responseEnd) + 'ms' +
        ' total=' + Math.round(nav.loadEventEnd - nav.startTime) + 'ms');
    }

    // Resource loading
    var resources = performance.getEntriesByType('resource');
    var slow = resources.filter(function(r) { return r.duration > 200; });
    if (slow.length > 0) {
      mark('slow-resources', slow.map(function(r) {
        return r.name.split('/').pop() + '=' + Math.round(r.duration) + 'ms';
      }).join(', '));
    }
    mark('total-resources', resources.length + ' files, ' +
      Math.round(resources.reduce(function(a, r) { return a + r.transferSize; }, 0) / 1024) + 'KB');
  });

  // Track WS connection
  var _origWsInit = null;
  var _wsConnectStart = 0;
  var _firstOutputTime = 0;

  // Intercept WS messages
  var _origSend = null;
  AB._perfHookWs = function(ws) {
    _wsConnectStart = Date.now();
    ws.addEventListener('open', function() {
      mark('ws-connected', (Date.now() - _wsConnectStart) + 'ms');
    });

    var msgCount = 0;
    ws.addEventListener('message', function(e) {
      msgCount++;
      var m = JSON.parse(e.data);
      if (m.type === 'output-full' && !_firstOutputTime) {
        _firstOutputTime = Date.now();
        mark('first-output', (Date.now() - _perf.start) + 'ms from start, ' + m.lines.length + ' lines');
      }
      if (msgCount === 1) mark('first-ws-message', m.type);
    });

    // Track sends
    var origSend = ws.send.bind(ws);
    ws.send = function(data) {
      var m = JSON.parse(data);
      if (m.type === 'input') mark('input-sent', m.text.slice(0, 30));
      if (m.type === 'active') mark('session-switch', 'id=' + m.id);
      return origSend(data);
    };
  };

  // Track render timing
  AB._perfMarkRender = function(type, lines, ms) {
    mark('render-' + type, lines + ' lines, ' + ms + 'ms');
  };

  // Report on demand
  AB._perfReport = function() {
    console.log('\n=== Performance Report ===');
    _perf.marks.forEach(function(m) {
      console.log('  +' + m.t + 'ms\t' + m.name + (m.detail ? '\t' + m.detail : ''));
    });
    console.log('=== End Report ===\n');

    // Send to server
    fetch('/api/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userAgent: navigator.userAgent,
        screen: window.innerWidth + 'x' + window.innerHeight,
        mobile: window.innerWidth <= 768,
        marks: _perf.marks
      })
    }).catch(function() {});

    return _perf.marks;
  };

  // Auto-report after 10 seconds
  setTimeout(function() { AB._perfReport(); }, 10000);

  AB._perfMark = mark;

})(window.AB = window.AB || {});
