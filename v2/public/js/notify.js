// ── Notifications: Audio, Title Blink, Browser Notifications ──

(function(AB) {

  var _notifyEnabled = localStorage.getItem('notifyEnabled') !== 'false';
  var _titleBlinkTimer = null;
  var _blinkMessages = [];
  var _blinkStopListener = null;

  function isEnabled() { return _notifyEnabled; }

  function toggle() {
    _notifyEnabled = !_notifyEnabled;
    localStorage.setItem('notifyEnabled', _notifyEnabled);
    var btn = document.getElementById('notify-btn');
    if (btn) btn.textContent = _notifyEnabled ? '\ud83d\udd14' : '\ud83d\udd15';
  }

  function updateBtn() {
    var btn = document.getElementById('notify-btn');
    if (btn) btn.textContent = _notifyEnabled ? '\ud83d\udd14' : '\ud83d\udd15';
  }

  function playBeep(type) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'waiting') { osc.frequency.value = 880; osc.type = 'sine'; }
      else { osc.frequency.value = 660; osc.type = 'square'; }
      gain.gain.value = 0.08;
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

  function startTitleBlink(msg) {
    _blinkMessages.push(msg);
    if (_titleBlinkTimer) return;
    var orig = document.title;
    var tick = 0;
    _titleBlinkTimer = setInterval(function() {
      if (_blinkMessages.length === 0) return;
      tick++;
      if (tick % 2 === 1) {
        var idx = Math.floor(tick / 2) % _blinkMessages.length;
        document.title = '\u26a1 ' + _blinkMessages[idx];
      } else {
        document.title = orig;
      }
    }, 600);

    if (!_blinkStopListener) {
      _blinkStopListener = function() {
        if (!document.hidden) {
          setTimeout(function() {
            if (_titleBlinkTimer) {
              clearInterval(_titleBlinkTimer);
              _titleBlinkTimer = null;
              _blinkMessages = [];
              document.title = orig;
            }
          }, 2000);
        }
      };
      document.addEventListener('visibilitychange', _blinkStopListener);
    }
  }

  function flashTab(id) {
    var item = document.querySelector('.session-item[data-id="' + id + '"]');
    if (!item) return;
    item.classList.add('session-flash');
    setTimeout(function() { item.classList.remove('session-flash'); }, 3000);
  }

  function notify(title, body, type, id) {
    if (!_notifyEnabled) return;
    playBeep(type);
    flashTab(id);
    if (document.hidden) startTitleBlink(title);
    if (Notification.permission === 'granted') {
      try { new Notification(title, { body: body, tag: 'termhub-' + Date.now() }); } catch (e) {}
    }
  }

  function shouldNotify(id) {
    if (document.hidden) return true;
    if (id && AB.store.activeId && String(AB.store.activeId) !== String(id)) return true;
    return false;
  }

  // Hook into store events for auto-notifications
  function init() {
    var store = AB.store;

    store.addEventListener('state-changed', function(e) {
      var id = e.detail.id;
      var state = e.detail.state;
      var prev = e.detail.prev;
      if (!prev) return; // initial load
      if (prev === 'working' && state === 'idle') {
        notify('#' + id + ' Complete', 'Session finished working', 'done', id);
      }
      if (state === 'waiting') {
        notify('#' + id + ' Waiting', 'Needs input', 'waiting', id);
      }
    });

    store.addEventListener('status-changed', function(e) {
      var id = e.detail.id;
      var status = e.detail.status;
      var prev = e.detail.prev;
      if (!prev) return;
      if (status === 'completed') {
        notify('#' + id + ' Completed', 'Session completed', 'done', id);
      } else if (status === 'stopped' && shouldNotify(id)) {
        notify('#' + id + ' Stopped', 'Session stopped', 'done', id);
      }
    });

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    updateBtn();
  }

  AB.notify = { init: init, toggle: toggle, updateBtn: updateBtn, notify: notify, isEnabled: isEnabled };

})(window.AB = window.AB || {});
