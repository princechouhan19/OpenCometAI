# src/core/

This folder contains **cross-cutting concerns** that don't belong to a single layer.

## Files

### `session.js`
Session management — tracks the current agent session ID, elapsed time, step counts.
Used by both the background and sidepanel to correlate events.

### `events.js`
Typed event bus — thin wrapper around `chrome.runtime.sendMessage` with message-type
safety from `constants.js`. Prevents magic-string bugs across the codebase.

### `logger.js`
Structured logging — in development builds, logs agent steps to console with timestamps.
In production, no-ops to avoid polluting extension devtools.

## Design Principle
Nothing in `core/` depends on anything in `src/background/`, `src/content/`, or
`src/sidepanel/`. It only imports from `src/lib/`. This keeps the dependency graph clean
and allows each layer to import from `core/` without circular deps.
