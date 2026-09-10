// ─────────────────────────────────────────────────────────────────────────────
// src/core/session.js
// Session metadata — elapsed time, step count, session ID utilities.
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a unique session ID. */
export function generateSessionId() {
  return `nx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Format elapsed ms as "1m 23s" or "45s". */
export function formatElapsed(startTimeMs) {
  const elapsed = Math.floor((Date.now() - startTimeMs) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m ${s}s`;
}

/** Return a summary label for a session status. */
export function statusLabel(status) {
  const labels = {
    idle:       'Idle',
    done:       'Completed',
    error:      'Error',
    stopped:    'Stopped by user',
    incomplete: 'Incomplete (max steps)',
    running:    'Running…',
    planning:   'Planning…',
    paused:     'Waiting for approval',
  };
  return labels[status] || status;
}
