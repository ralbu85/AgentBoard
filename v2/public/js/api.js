// ── API Helpers ──

(function(AB) {

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include'
    });
  }

  function get(url) {
    return fetch(url, { credentials: 'include' }).then(r => r.json());
  }

  AB.api = { post, get };

})(window.AB = window.AB || {});
