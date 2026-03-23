// ── SessionStore: Central State Management ──
// Single source of truth. UI modules subscribe to events.

(function(AB) {

  var _justCompleted = {};  // id → timeout handle (working→idle flash)

  class SessionStore extends EventTarget {
    #sessions = new Map(); // id → {cwd, cmd, status, aiState, process, createdAt, memKB, sessionName}
    #activeId = null;

    get activeId() { return this.#activeId; }

    get(id) { return this.#sessions.get(id); }

    has(id) { return this.#sessions.has(id); }

    ids() { return [...this.#sessions.keys()]; }

    entries() { return [...this.#sessions.entries()]; }

    get size() { return this.#sessions.size; }

    add(id, data) {
      this.#sessions.set(id, {
        cwd: data.cwd || '',
        cmd: data.cmd || 'claude',
        status: data.status || 'running',
        aiState: data.aiState || null,
        process: data.process || null,
        createdAt: data.createdAt || null,
        memKB: data.memKB || 0,
        sessionName: data.sessionName || ''
      });
      this.dispatchEvent(new CustomEvent('session-added', { detail: { id, data: this.#sessions.get(id) } }));
    }

    remove(id) {
      if (!this.#sessions.has(id)) return;
      this.#sessions.delete(id);
      clearTimeout(_justCompleted[id]);
      delete _justCompleted[id];
      this.dispatchEvent(new CustomEvent('session-removed', { detail: { id } }));
      if (this.#activeId === id) {
        const first = this.#sessions.keys().next().value;
        this.setActive(first || null);
      }
    }

    setActive(id) {
      if (this.#activeId === id) return;
      const prev = this.#activeId;
      this.#activeId = id;
      this.dispatchEvent(new CustomEvent('active-changed', { detail: { id, prev } }));
    }

    updateStatus(id, status) {
      const s = this.#sessions.get(id);
      if (!s) return;
      const prev = s.status;
      s.status = status;
      this.dispatchEvent(new CustomEvent('status-changed', { detail: { id, status, prev } }));
    }

    updateAiState(id, state) {
      const s = this.#sessions.get(id);
      if (!s) return;
      const prev = s.aiState;
      s.aiState = state;

      // working → idle: mark as "just completed" for visual feedback
      if (prev === 'working' && state === 'idle') {
        _justCompleted[id] = setTimeout(() => {
          delete _justCompleted[id];
          // Re-fire state-changed so UI updates from completed → idle
          this.dispatchEvent(new CustomEvent('state-changed', { detail: { id, state: 'idle', prev: 'idle' } }));
        }, 10000); // Show "completed" for 10 seconds
      }

      // If user starts working again, clear completed timer
      if (state === 'working' && _justCompleted[id]) {
        clearTimeout(_justCompleted[id]);
        delete _justCompleted[id];
      }

      this.dispatchEvent(new CustomEvent('state-changed', { detail: { id, state, prev } }));
    }

    updateCwd(id, cwd) {
      const s = this.#sessions.get(id);
      if (!s || s.cwd === cwd) return;
      s.cwd = cwd;
      this.dispatchEvent(new CustomEvent('cwd-changed', { detail: { id, cwd } }));
    }

    updateInfo(id, process, createdAt, memKB) {
      const s = this.#sessions.get(id);
      if (!s) return;
      s.process = process;
      s.createdAt = createdAt;
      if (memKB != null) s.memKB = memKB;
      this.dispatchEvent(new CustomEvent('info-changed', { detail: { id, process, createdAt, memKB: s.memKB } }));
    }

    updateTitle(id, title) {
      const s = this.#sessions.get(id);
      if (!s) return;
      this.dispatchEvent(new CustomEvent('title-changed', { detail: { id, title } }));
    }

    // Get effective visual state for display
    effectiveState(id) {
      const s = this.#sessions.get(id);
      if (!s) return 'stopped';
      if (s.status === 'completed') return 'completed';
      if (s.status === 'stopped') return 'stopped';
      // working → idle transition: show "completed" briefly
      if (_justCompleted[id]) return 'completed';
      if (s.aiState === 'waiting') return 'waiting';
      if (s.aiState === 'idle') return 'idle';
      if (s.aiState === 'working') return 'running';
      return 'running';
    }
  }

  AB.store = new SessionStore();

})(window.AB = window.AB || {});
