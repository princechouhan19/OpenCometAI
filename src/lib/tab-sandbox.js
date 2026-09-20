// src/lib/tab-sandbox.js
// TAB-GROUP SANDBOX (Claude-for-Chrome-style task boundary)
//
// The task's tabs live inside a dedicated tab group: any tabs the task
// needs are opened within it, so the group itself is the sandbox.
//
// This module is the single source of truth for that boundary. It is shared by
// src/background/sw.js (group lifecycle) and src/background/actions.js
// (per-action enforcement) so both sides can never drift apart.
//
// Design:
//   • VISIBLE boundary — every task tab lives in one Chrome tab group
//     (blue, titled with the task). The user can SEE the sandbox.
//   • TRACKED boundary — agentState.taskTabIds is the enforced member list;
//     the group is the visible container, the list is the enforcement set.
//   • FAIL-CLOSED, never fake — every helper degrades honestly (returns null,
//     logs a warning) instead of pretending the boundary exists. Grouping is
//     cosmetic containment; taskTabIds enforcement (actions.js) is the hard
//     boundary and keeps working even if Chrome refuses to group.

export const SANDBOX_GROUP_COLOR = 'blue';

export function sandboxTitleFor(task) {
  const base = String(task || 'Open Comet Task').replace(/\s+/g, ' ').trim();
  return (base || 'Open Comet Task').substring(0, 24);
}

// Pure membership check — safe on legacy contexts that carry no taskTabIds
// (e.g. old callers that pass `{ settings }` as the state handle).
export function isSandboxTab(agentState, tabId) {
  return Number.isInteger(tabId)
    && Array.isArray(agentState?.taskTabIds)
    && agentState.taskTabIds.includes(tabId);
}

// Pure filter — keep only sandbox tabs (optionally plus one extra id, e.g. the
// loop's current tab). Never throws; an empty/legacy state filters to nothing
// (callers decide their own fallback for that case).
export function filterToSandbox(agentState, tabs, { includeTabId = null } = {}) {
  const ids = new Set((agentState?.taskTabIds || []).filter(Number.isInteger));
  if (Number.isInteger(includeTabId)) ids.add(includeTabId);
  return (tabs || []).filter(t => ids.has(t.id));
}

/**
 * Ensure the given tabs are inside THIS task's tab group (creating the group
 * on first use, reusing agentState.agentGroupId afterwards).
 *
 * - Never throws: grouping failures (pinned tab, stale group id after a
 *   Chrome restart, …) are logged once and return null — the tracked
 *   taskTabIds enforcement keeps the agent bounded either way.
 * - Chrome MOVES tabs into the group's window when needed, which is exactly
 *   the containment behavior we want for popups opened on another window.
 *
 * @param {object} agentState  Live agent state (agentGroupId/task/taskTabIds).
 * @param {number[]} tabIds    Tabs to place inside the sandbox group.
 * @param {string} [title]     Optional group title override.
 * @returns {Promise<number|null>} groupId, or null when grouping failed.
 */
export async function ensureTaskGroup(agentState, tabIds, title) {
  const ids = (tabIds || []).filter(Number.isInteger);
  // Legacy contexts (e.g. `{ settings }` handles from old callers) carry no
  // taskTabIds — they are NOT agent runs; grouping must stay a safe no-op.
  const isAgentState = agentState && Array.isArray(agentState.taskTabIds);
  if (!isAgentState || !ids.length) return agentState?.agentGroupId ?? null;

  const style = async (groupId) => {
    try {
      await chrome.tabGroups.update(groupId, {
        title: sandboxTitleFor(title ?? agentState.task),
        color: SANDBOX_GROUP_COLOR,
        collapsed: false,
      });
    } catch { /* styling is cosmetic — the group itself already exists */ }
  };

  // 1) Reuse the existing group when we have one.
  if (Number.isInteger(agentState.agentGroupId)) {
    try {
      const groupId = await chrome.tabs.group({ groupId: agentState.agentGroupId, tabIds: ids });
      agentState.agentGroupId = groupId;
      await style(groupId);
      return groupId;
    } catch (err) {
      // Stale group id (Chrome restart, user dissolved the group, …) → fall
      // through and create a fresh group below.
      console.warn('[Open Comet] Sandbox: reusing the task group failed, creating a fresh one —', err?.message || err);
    }
  }

  // 2) Create (or reuse via Chrome's own merging) a group for these tabs.
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids });
    agentState.agentGroupId = groupId;
    await style(groupId);
    return groupId;
  } catch (err) {
    // Known cause: pinned tabs cannot join groups. The agent stays bounded by
    // taskTabIds enforcement either way — say so once, honestly.
    console.warn('[Open Comet] Sandbox: could not place task tab(s) in a group (agent stays bounded to its tracked tabs) —', err?.message || err);
    return null;
  }
}
