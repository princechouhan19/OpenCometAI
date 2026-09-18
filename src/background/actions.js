// ─────────────────────────────────────────────────────────────────────────────
// src/background/actions.js
// DOM action executors — each action type runs inside the target tab.
// Native browser tools (bookmarks, saves, monitors, skills) run in the SW.
// Imported and called by the agent loop in sw.js.
// ─────────────────────────────────────────────────────────────────────────────

import { sleep } from '../lib/utils.js';
import { getAllSkills } from '../lib/skills.js';
import { searchPageParts, highlightPart } from '../lib/page-rag.js';
import { findInHistory } from '../lib/vector-history.js';
// v1.15 TAB-GROUP SANDBOX: shared boundary logic (same module the SW uses).
import { ensureTaskGroup, filterToSandbox } from '../lib/tab-sandbox.js';

/**
 * Execute a single agent action in the given tab.
 * Returns a metadata object { ok, …outcome fields }.
 */
export async function executeAction(tabId, action, agentState) {
  switch (action.type) {

    // ── Navigate ───────────────────────────────────────────────────────────
    case 'navigate': {
      // SIH Phase 16: URL allow-list — the VLM must not steer the browser onto
      // browser-internal or non-web schemes (chrome://, file://, javascript:,
      // data:). Only http(s) passes.
      const navUrl = String(action.url || '').trim();
      if (!/^https?:\/\//i.test(navUrl)) {
        throw new Error(`navigate: only http(s) URLs are allowed — blocked: "${navUrl.slice(0, 80)}"`);
      }
      const tab = await chrome.tabs.update(tabId, { url: navUrl });
      await sleep(800);
      return { ok: true, url: tab.url, tabId: tab.id };
    }

    // ── Click ──────────────────────────────────────────────────────────────
    case 'click': {
      const clickContext = {
        ...(getInteractiveContext(action, agentState) || {}),
        x: Number.isFinite(Number(action.x)) ? Number(action.x) : null,
        y: Number.isFinite(Number(action.y)) ? Number(action.y) : null,
      };
      // ── Action verification ────────────────────────────────────────────
      // Synthetic clicks on modern SPA players (YouTube etc.) are sometimes
      // silently ignored — the old code reported "success" because the DOM
      // call didn't throw, and the VLM declared the task done while nothing
      // had happened. We now fingerprint the page BEFORE and AFTER and feed
      // the honest diff back to the model + console.
      const before = await inject(tabId, domPageFingerprint);
      // v1.11: collapsed field-group aware click resolution (Gmail opens the
      // compose dialog with the recipients row collapsed — the "To" input is
      // only created after the visible "Recipients" chip is clicked).
      const result = await executeClickWithExpansion(tabId, action.selector || action.text || '', clickContext);
      if (!result?.ok) throw new Error(clickFailMessage(result));
      await sleep(750);   // let SPA state settle (playback toggles, navigations)
      let after = await inject(tabId, domPageFingerprint);
      // SIH: ignore media TIME drift for non-media actions — 750ms of video
      // playback always drifted >0.35s and faked "PAGE CHANGED" for dead clicks.
      let verification = diffFingerprints(before, after, { ignoreMediaTime: true });
      // v1.15 NAVIGATION LENS: when the click NAVIGATED, the post-action
      // injection legitimately fails (the document is mid-teardown) and
      // diffFingerprints reports "fingerprint unavailable → no change".
      // Before v1.15 that verdict was then masked to "VERIFIED" on EVERY site
      // by the mail-probe composeClosed=true bug (the user's YouTube field
      // log caught it: "mail send flow advanced" on a Music-nav click). The
      // tab itself is the honest signal source: if the tab's URL/title moved
      // vs the pre-click fingerprint, the click DID navigate. Strictly scoped
      // to `!after` — it can never inflate a readable-page verdict.
      if (!after && before) {
        const nav = await tabNavigationSignal(tabId, before);
        if (nav) verification = nav;
      }
      // v1.11 trusted-input fallback: a synthetic (isTrusted=false) click that
      // verifies as ineffective is re-dispatched as REAL browser input via the
      // DevTools protocol (chrome.debugger). Hardened widgets (Gmail Send,
      // player controls) ignore synthetic events but must honor real ones.
      // Attaching fails harmlessly when DevTools already owns the tab — we
      // keep the synthetic verdict instead of guessing.
      if (!verification.changed && result.rect) {
        const trusted = await trustedClick(tabId, result.rect);
        if (trusted?.ok) {
          await sleep(750);
          const after2 = await inject(tabId, domPageFingerprint);
          const v2 = diffFingerprints(before, after2, { ignoreMediaTime: true });
          if (v2.changed) {
            verification = v2;
            after = after2;
            result.trustedRetry = true;
            console.log('[Open Comet] Click re-dispatched as TRUSTED input (CDP) → PAGE CHANGED');
          }
        } else if (trusted?.reason) {
          console.log(`[Open Comet] Trusted-click fallback unavailable: ${trusted.reason}`);
        }
      }
      // SIH: mail/compose success signals — clicking Send closes the compose
      // window and raises a "Message sent" toast, which the structural
      // fingerprint can miss while the dialog is mid-teardown. Probe the
      // explicit success markers before declaring "no visible change".
      // v1.15 HOST GATE: the probe only makes sense on mail hosts. Field log
      // (v1.14.3, YouTube): with no compose dialog ever present,
      // composeClosed=true fired and the history claimed "mail send flow
      // advanced" for a Music-nav click — confusing honesty for the VLM.
      if (!verification.changed && await isMailHostTab(tabId)) {
        try {
          const mail = await inject(tabId, verifyMailSendOutcome);
          if (mail?.sent || mail?.composeClosed) {
            verification = {
              changed: true,
              summary: mail.composeClosed
                ? 'compose window closed after the click (mail send flow advanced)'
                : `mail success toast detected ("${String(mail.toast || '').slice(0, 40)}")`,
            };
            result.mailSendVerified = true;
            console.log('[Open Comet] Click verify · mail send signals detected → PAGE CHANGED');
          }
        } catch { /* additive verification only */ }
      }
      result.changed = verification.changed;
      result.verification = verification;
      console.log(`[Open Comet] Click verify · target="${String(action.selector || action.text || '').substring(0, 60)}" · matched="${String(result.matchedText || '').substring(0, 60)}"${result.resolution ? ` via ${result.resolution}` : ''}${result.expandedToggle ? ` (expanded "${result.expandedToggle}")` : ''} → ` +
        `${verification.changed ? 'PAGE CHANGED' : 'NO VISIBLE CHANGE'} · ${verification.summary}`);
      if (!verification.changed) {
        console.warn('[Open Comet] Click had no visible effect. Page fingerprint before/after:', before, after);
      }
      return result;
    }

    // ── Media control (direct <video>/<audio> drive) ───────────────────────
    // Reliable fallback for player UI clicks that pages ignore: this drives
    // the media element itself, exactly like OS-level media keys do.
    case 'media':
    case 'media_control': {
      const cmd = String(action.command || action.cmd || 'pause').toLowerCase();
      if (!['pause', 'play', 'mute', 'unmute', 'toggle'].includes(cmd)) {
        throw new Error(`media: unknown command "${cmd}" (use pause|play|mute|unmute)`);
      }
      const beforeMedia = await inject(tabId, domMediaState);

      const result = await inject(tabId, domMediaControl, cmd);

      if (!result?.ok) throw new Error(result?.reason || `No page media to ${cmd}`);

      await sleep(400);

      const afterMedia = await inject(tabId, domMediaState);

      // SIH: REAL verification — compare playback STATE (paused/muted), never a

      // null baseline (the old code always reported success) and never currentTime

      // (it drifts for free on a playing video).

      const sig = s => JSON.stringify((s || []).map(x => [x.paused, x.muted]));

      const mediaChanged = sig(beforeMedia) !== sig(afterMedia);

      // v1.15.1 HONEST NO-OP (field log: "media play" on an ALREADY playing
      // video → "verified=NO CHANGE" → the VLM burned a full extra turn
      // re-playing and only recovered by luck). A no-op that leaves the media
      // in the REQUESTED state is a VERIFIED success, not a verification
      // failure — report alreadyInState so the loop and the model both see it.
      const wantedFor = {
        pause: b => b.paused === true,
        play: b => b.paused === false,
        mute: b => b.muted === true,
        unmute: b => b.muted === false,
        toggle: () => false,
      };
      const alreadyOk = Boolean(result?.before && (wantedFor[cmd] || (() => false))(result.before));
      const alreadyInState = !mediaChanged && alreadyOk;

      result.changed = mediaChanged;
      result.alreadyInState = alreadyInState;

      result.verification = {

        changed: mediaChanged,

        summary: mediaChanged

          ? `media state changed → ${JSON.stringify(afterMedia || []).slice(0, 80)}`

          : alreadyInState

            ? `media already ${cmd === 'pause' ? 'paused' : cmd === 'play' ? 'playing' : cmd + 'd'} — no change was needed (verified)`

            : `media state UNCHANGED (already ${cmd === 'pause' ? 'paused' : cmd === 'play' ? 'playing' : cmd + 'd'}?)`,

      };

      console.log(`[Open Comet] Media ${cmd} · ${result.matched} → paused=${result.state?.paused} muted=${result.state?.muted} · verified=${mediaChanged ? 'CHANGED' : alreadyInState ? 'ALREADY IN STATE' : 'NO CHANGE'}`);
      return result;
    }

    // ── Type / Fill ────────────────────────────────────────────────────────
    case 'type':
    case 'fill': {
      const fieldContext = getInteractiveContext(action, agentState);
      const buildArgs = () => [action.selector, action.text ?? action.value ?? '', fieldContext];
      let result = await inject(tabId, domType, ...buildArgs());
      // v1.11: the requested field may not exist yet — Gmail compose opens
      // with the recipients row COLLAPSED ("Recipients" chip; the To <input>
      // is created only after the chip is clicked). domType reports
      // needExpand + tokens; we click the group toggle, wait for the row to
      // render, and retry once. The failure path also carries a field
      // INVENTORY so the VLM sees what IS on the page.
      if (result && !result.ok && result.needExpand) {
        console.log(`[Open Comet] Field not found (${String(action.selector).slice(0, 50)}…) — expanding collapsed field group…`);
        const expanded = await inject(tabId, domExpandToggle, result.tokens || []);
        if (expanded?.ok) {
          console.log(`[Open Comet] Expanded "${expanded.label}" — retrying type`);
          await sleep(450);
          const retry = await inject(tabId, domType, ...buildArgs());
          if (retry) {
            if (retry.ok) retry.expandedToggle = expanded.label;
            result = retry;
          }
        }
      }
      if (!result?.ok) {
        throw new Error((result?.reason || `Type failed: ${action.selector}`) + (result?.inventory ? ` — on page: ${result.inventory}` : ''));
      }
      // SIH Phase 16: propagate read-back verification — a typed value that
      // didn't stick is a STALL for the loop governor (same as an ineffective
      // click), not a silent success.
      if (result.verified === false) {
        result.changed = false;
        console.warn(`[Open Comet] Type verify · value did NOT stick in field (${result.fieldType})`);
      } else if (result.verified === true) {
        result.changed = true;
      }
      return result;
    }

    // ── Key press ──────────────────────────────────────────────────────────
    case 'press_key':
    case 'key': {
      const before = await inject(tabId, domPageFingerprint);
      await inject(tabId, domKey, action.key || 'Return');
      await sleep(600);
      const after = await inject(tabId, domPageFingerprint);
      // SIH: same ignoreMediaTime rule as clicks (a playing video faked change).
      let verification = diffFingerprints(before, after, { ignoreMediaTime: true });
      // v1.15: same navigation lens as clicks (Ctrl+Enter sends → navigate).
      if (!after && before) {
        const nav = await tabNavigationSignal(tabId, before);
        if (nav) verification = nav;
      }
      console.log(`[Open Comet] Key verify · ${action.key || 'Return'} → ${verification.changed ? 'PAGE CHANGED' : 'no visible change'} · ${verification.summary}`);
      return { ok: true, key: action.key, changed: verification.changed, verification };
    }

    // ── Submit form ────────────────────────────────────────────────────────
    case 'submit': {
      // SIH v1.14: submit previously returned domSubmit's ok with NO effect
      // verification — an SPA in-place submission (no navigation) read as an
      // unverified fire-and-forget. Verify with the same fingerprint diff the
      // click path uses (content signatures catch in-place success messages).
      const before = await inject(tabId, domPageFingerprint);
      const result = await inject(tabId, domSubmit, action.selector || '');
      if (!result?.ok) throw new Error(result?.reason || 'Submit failed');
      await sleep(750);
      const after = await inject(tabId, domPageFingerprint);
      const verification = diffFingerprints(before, after, { ignoreMediaTime: true });
      result.changed = verification.changed;
      result.verification = verification;
      console.log(`[Open Comet] Submit verify · ${verification.changed ? 'PAGE CHANGED' : 'NO VISIBLE CHANGE'} · ${verification.summary}`);
      return result;
    }

    // ── Scroll ─────────────────────────────────────────────────────────────
    case 'scroll': {
      const result = await inject(tabId, domScroll, action.direction || 'down', action.amount || 600);
      if (!result?.ok) throw new Error('Scroll failed');
      if ((action.direction === 'down' || action.direction === 'bottom') && result.atBottom && result.moved < 24) {
        throw new Error(`Scroll hit bottom of ${result.target}`);
      }
      if ((action.direction === 'up' || action.direction === 'top') && result.atTop && result.moved < 24) {
        throw new Error(`Scroll hit top of ${result.target}`);
      }
      return result;
    }

    // ── Scroll to UID ──────────────────────────────────────────────────────
    case 'scroll_to_uid': {
      const uid = String(action.uid || action.selector || '').replace(/^uid:/, '');
      const result = await inject(tabId, domScrollToUid, uid);
      if (!result?.ok) throw new Error(result?.reason || 'scroll_to_uid failed');
      return result;
    }

    // ── Scroll to text ─────────────────────────────────────────────────────
    case 'scroll_to_text': {
      const result = await inject(tabId, domScrollToText, action.text || action.selector || '');
      if (!result?.ok) throw new Error(result?.reason || 'scroll_to_text failed');
      return result;
    }

    // ── Wait ───────────────────────────────────────────────────────────────
    case 'wait':
      await sleep(action.ms || 2000);
      return { ok: true, waitedMs: action.ms || 2000 };

    // ── Extract (passive — next loop reads the result) ─────────────────────
    case 'extract':
      await inject(tabId, (sel) => {
        return [...document.querySelectorAll(sel || 'body')]
          .map(el => el.textContent.trim())
          .join('\n');
      }, action.selector || 'body');
      return { ok: true };

    // ── New tab ────────────────────────────────────────────────────────
    case 'new_tab': {
      // v1.16.1 SANDBOX FIX: new_tab created tabs with the model-provided URL
      // UNCHECKED, while navigate enforces http(s)-only — a prompt-injected
      // model could open chrome://settings, file:// or the Web Store from a
      // "sandboxed" run. Same allow-list as navigate now applies.
      const newTabUrl = String(action.url || '').trim();
      if (newTabUrl && !/^https?:\/\//i.test(newTabUrl)) {
        throw new Error(`new_tab: only http(s) URLs are allowed — blocked: "${newTabUrl.slice(0, 80)}"`);
      }
      const tab = await chrome.tabs.create({ url: newTabUrl || 'about:blank', active: true });
      agentState.agentTabId = tab.id;
      agentState.taskTabIds = [...new Set([...(agentState.taskTabIds || []), tab.id])];
      // v1.15 TAB-GROUP SANDBOX: task tabs open INSIDE the task group — the
      // visible sandbox boundary. Previously the new tab landed at the end of
      // the window, outside the group (and with legacy throwaway state this
      // action even crashed on spreading `undefined`).
      await ensureTaskGroup(agentState, [tab.id]);
      await sleep(1000);
      return { ok: true, tabId: tab.id, url: tab.url, sandbox: 'task-group' };
    }

    // ── Switch tab ─────────────────────────────────────────────────────────
    case 'switch_tab': {
      const targetId = resolveTabId(action, agentState);
      if (!targetId) throw new Error('No task tab matched switch_tab target');
      const tab = await chrome.tabs.get(targetId);
      await chrome.tabs.update(targetId, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      agentState.agentTabId = targetId;
      return { ok: true, tabId: targetId, url: tab.url };
    }

    // ── Close tab ────────────────────────────────────────────────────────
    case 'close_tab': {
      const closeId = resolveTabId(action, agentState) || tabId;
      if (Number.isInteger(closeId) && Array.isArray(agentState.taskTabIds) && agentState.taskTabIds.length
          && !agentState.taskTabIds.includes(closeId)) {
        // v1.15 TAB-GROUP SANDBOX: resolveTabId is already sandbox-bounded;
        // this guard keeps the `|| tabId` fallback from ever escaping it.
        throw new Error('close_tab refused — target tab is outside the task sandbox');
      }
      if (agentState.taskTabIds.length <= 1 && closeId === agentState.agentTabId) {
        throw new Error('Cannot close the only active task tab');
      }
      await chrome.tabs.remove(closeId);
      agentState.taskTabIds = agentState.taskTabIds.filter(id => id !== closeId);
      delete agentState.taskTabGraph[closeId];
      agentState.agentTabId = agentState.taskTabIds.at(-1) ?? agentState.currentTabId;
      return { ok: true, tabId: closeId };
    }

    // ── Search ─────────────────────────────────────────────────────────────
    case 'search': {
      const result = await inject(tabId, domSearch, action.query || '', getSearchContext(agentState));
      if (!result?.ok) throw new Error(result?.reason || 'Search action failed');
      return result;
    }

    // ══ Native browser tools (skill library support) ════════════════════════
    // These run purely in the service worker via chrome.* APIs — no DOM
    // injection needed. They power the skills in /skills/*.md.

    // ── Bookmark current/other page ──────────────────────────────────────────
    case 'bookmark_add': {
      const url   = String(action.url || agentState.lastPageInfo?.url || '').trim();
      const title = String(action.title || agentState.lastPageInfo?.title || url || 'Untitled').trim();
      if (!/^https?:/i.test(url)) throw new Error('bookmark_add needs a valid http(s) URL');
      const existing = await chrome.bookmarks.search({ url });
      if (existing?.length) return { ok: true, existed: true, bookmark: { title: existing[0].title, url: existing[0].url } };
      const folder = await ensureAgentBookmarkFolder();
      const created = await chrome.bookmarks.create({ parentId: folder.id, title: title.substring(0, 120), url });
      return { ok: true, bookmark: { title: created.title, url: created.url }, folder: folder.title };
    }

    // ── Search bookmarks ─────────────────────────────────────────────────────
    case 'bookmark_search': {
      const query = String(action.query || '').trim();
      const found = query ? await chrome.bookmarks.search(query) : await chrome.bookmarks.search({});
      const results = (found || [])
        .filter(b => b.url && /^https?:/i.test(b.url))
        .slice(0, 10)
        .map(b => ({ title: b.title, url: b.url }));
      return { ok: true, count: results.length, results };
    }

    // ── Save current page as MHTML archive ──────────────────────────────────
    case 'save_page': {
      // v1.17.0: chrome.pageCapture is Chromium-only — fail with an honest,
      // actionable message on Firefox instead of a TypeError.
      if (!chrome.pageCapture?.captureMHTML) {
        throw new Error('save_page needs Chromium (chrome.pageCapture is unavailable on this browser). Use screenshot_save instead.');
      }
      const mhtml = await chrome.pageCapture.captureMHTML({ tabId });
      if (!mhtml) throw new Error('Could not capture page (chrome:// pages cannot be saved)');
      const title = String(agentState.lastPageInfo?.title || 'page').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').substring(0, 60) || 'page';
      const filename = `OpenComet/${title}-${Date.now()}.mhtml`;
      const downloadId = await chrome.downloads.download({ url: mhtml, filename, saveAs: false });
      return { ok: true, filename, downloadId };
    }

    // ── Save visible screenshot ─────────────────────────────────────────────
    case 'screenshot_save': {
      // v1.15 TAB-GROUP SANDBOX: captureVisibleTab photographs the ACTIVE tab
      // of the window — if the visible tab is not a task tab, re-focus the
      // sandbox first so the agent never screenshots (and saves) a foreign
      // page. Legacy contexts without taskTabIds keep the old behavior.
      let winId = agentState.lastWindowId ?? undefined;
      try {
        const ids = (agentState.taskTabIds || []).filter(Number.isInteger);
        if (ids.length) {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (active && !ids.includes(active.id)) {
            const focusId = ids.includes(agentState.agentTabId) ? agentState.agentTabId : ids[ids.length - 1];
            await chrome.tabs.update(focusId, { active: true });
            winId = (await chrome.tabs.get(focusId)).windowId;
            await sleep(250);
          } else if (active) {
            winId = active.windowId;
          }
        }
      } catch { /* best-effort focus pinning */ }
      const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
      if (!dataUrl) throw new Error('Screenshot capture failed (protected page?)');
      const slug = String(action.label || `step-${Date.now()}`).replace(/[^\w-]/g, '-').substring(0, 40);
      const filename = `OpenComet/screenshot-${slug}.png`;
      const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      return { ok: true, filename, downloadId };
    }

    // ── Organize tabs: group by host / close duplicates ──────────────────────
    case 'organize_tabs': {
      const mode = String(action.mode || 'group');
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const agentIds = new Set(agentState.taskTabIds || []);
      // v1.15 TAB-GROUP SANDBOX: scope EVERY organizing (grouping AND closing)
      // to the task's own tabs. Previously this action regrouped and even
      // CLOSED the user's other tabs window-wide — the opposite of a sandbox.
      const candidates = filterToSandbox(agentState, tabs).filter(t => /^https?:/i.test(t.url || ''));

      let closed = 0;
      const groupsMade = [];

      if (mode === 'dedupe' || mode === 'cleanup') {
        const seenUrls = new Set();
        const toClose = [];
        for (const t of candidates) {
          const norm = normalizeTabUrl(t.url);
          if (seenUrls.has(norm)) toClose.push(t.id); else seenUrls.add(norm);
        }
        // never close the agent's own task tabs
        const safeClose = toClose.filter(id => !agentIds.has(id));
        if (safeClose.length) { await chrome.tabs.remove(safeClose); closed = safeClose.length; }
      }

      if (mode === 'group' || mode === 'cleanup') {
        const byHost = new Map();
        for (const t of candidates) {
          if (agentIds.has(t.id) && t.id === agentState.agentTabId) continue;
          let host = 'other';
          try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
          if (!byHost.has(host)) byHost.set(host, []);
          byHost.get(host).push(t.id);
        }
        for (const [host, ids] of byHost) {
          const single = ids.length === 1;
          if (single && mode !== 'group') continue; // cleanup: only group multi-tab hosts
          try {
            const gid = await chrome.tabs.group({ tabIds: ids });
            await chrome.tabGroups.update(gid, { title: host.substring(0, 18) });
            groupsMade.push({ host, tabs: ids.length });
          } catch { /* grouping unavailable — skip silently */ }
        }
      }

      return { ok: true, closed, groups: groupsMade };
    }

    // ── Reading list ─────────────────────────────────────────────────────────
    case 'read_later_add': {
      const url   = String(action.url || agentState.lastPageInfo?.url || '').trim();
      const title = String(action.title || agentState.lastPageInfo?.title || url || 'Untitled').trim();
      if (!/^https?:/i.test(url)) throw new Error('read_later_add needs a valid http(s) URL');
      const list = await getReadingList();
      if (list.some(item => item.url === url)) {
        return { ok: true, existed: true, count: list.length };
      }
      if (chrome.readingList?.addItem) {
        await chrome.readingList.addItem({ url, title: title.substring(0, 120), hasBeenRead: false });
      }
      const entry = { url, title: title.substring(0, 160), addedAt: Date.now() };
      await saveReadingList([...list, entry]);
      return { ok: true, added: entry, count: list.length + 1 };
    }

    case 'read_later_list': {
      const list = await getReadingList();
      const merged = await mergeWithNativeReadingList(list);
      return { ok: true, count: merged.length, items: merged.slice(-20).reverse() };
    }

    // ── Page monitor (alarms + notification on change) ───────────────────────
    case 'monitor_start': {
      const url        = String(action.url || agentState.lastPageInfo?.url || '').trim();
      const intervalMin = Math.min(240, Math.max(5, Number(action.intervalMin) || 15));
      const checkText  = String(action.checkText || '').trim();
      if (!/^https?:/i.test(url)) throw new Error('monitor_start needs a valid http(s) URL');

      const monitors = await getMonitors();
      const id = monitorIdFor(url);
      const monitor = { id, url, intervalMin, checkText, lastText: '', createdAt: Date.now() };
      monitors.set(id, monitor);
      await saveMonitors(monitors);

      await chrome.alarms.create(`opencomet_monitor_${id}`, { periodInMinutes: intervalMin });

      // Capture the baseline immediately so the first alarm can diff against it
      try {
        const baseline = await fetchPageText(url);
        monitor.lastText = (baseline || '').substring(0, 8000);
        monitors.set(id, monitor);
        await saveMonitors(monitors);
      } catch { /* baseline optional — alarm will capture on first run */ }

      return { ok: true, monitor: { url, intervalMin, checkText: checkText || '(any change)' } };
    }

    // ── Activate a library skill mid-task (model-invoked) ────────────────────
    case 'use_skill': {
      const requested = String(action.id || action.skill || '').trim();
      if (!requested) throw new Error('use_skill needs a skill id from the SKILL LIBRARY');
      const match = await resolveSkill(requested);
      if (!match) throw new Error(`Unknown skill "${requested}" — pick an id from the SKILL LIBRARY list`);
      agentState.skills = agentState.skills || [];
      if (agentState.skills.some(s => s.id === match.id)) {
        return { ok: true, skill: match.name, alreadyActive: true, prompt: match.prompt, doneChecklist: match.doneChecklist };
      }
      agentState.skills.push({
        id: match.id, name: match.name, prompt: match.prompt,
        allowedHosts: match.allowedHosts || [], preferredSites: match.preferredSites || [],
        doneChecklist: match.doneChecklist || [],
      });
      return { ok: true, skill: match.name, prompt: match.prompt, doneChecklist: match.doneChecklist };
    }

    // ══ Page-RAG + semantic tools (gemma4-browser-extension ports) ═════════

    // ── List open tabs (feed switch_tab/close_tab decisions) ──────────────
    case 'list_tabs': {
      // v1.15 TAB-GROUP SANDBOX: the agent may only see its OWN task tabs.
      // The old behavior listed EVERY window tab — user tabs (banking, mail,
      // personal sites) leaked their titles+URLs into the VLM prompt, and the
      // model was invited to reason about pages outside the sandbox.
      const all = await chrome.tabs.query({ currentWindow: true });
      const sandboxTabs = filterToSandbox(agentState, all, { includeTabId: tabId });
      const results = sandboxTabs
        .filter(t => t.id !== tabId)
        .slice(0, 25)
        .map(t => {
          let host = '';
          try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
          return { id: t.id, host, title: String(t.title || '').substring(0, 80), url: String(t.url || '').substring(0, 120), active: Boolean(t.active) };
        });
      const inSandbox = sandboxTabs.some(t => t.id === tabId);
      return {
        ok: true,
        scope: 'task-sandbox',
        count: results.length,
        tabs: results,
        note: inSandbox
          ? 'Listing only this task\'s sandboxed tabs — other browser tabs are outside the agent sandbox.'
          : 'No other task tabs in the sandbox.',
      };
    }

    // ── Semantic search over the CURRENT page (RAG) ───────────────────────
    case 'ask_website': {
      const query = String(action.query || '').trim();
      if (!query) throw new Error('ask_website needs a query');
      const topK = Math.min(8, Math.max(1, Number(action.topK) || 3));
      const results = await searchPageParts(tabId, agentState.lastPageInfo?.url || '', query, topK);
      if (!results.length) {
        return { ok: true, count: 0, summary: 'No relevant content found on the current page.' };
      }
      const lines = results.map((r, i) =>
        `[${i + 1}] ID: ${r.id} | ${String(r.tagName).toUpperCase()} (score ${r.score.toFixed(2)}):\n${String(r.content).substring(0, 700)}`);
      return {
        ok: true,
        count: results.length,
        results,
        summary: `Found ${results.length} relevant section(s):\n\n${lines.join('\n\n')}\n\nTip: highlight_element with an ID above to show the user the exact spot.`,
      };
    }

    // ── Scroll to + highlight a section by its ask_website ID ─────────────
    case 'highlight_element': {
      const id = String(action.id || action.selector || '').trim();
      if (!id) throw new Error('highlight_element needs a section id from ask_website results');
      const resp = await highlightPart(tabId, id);
      if (!resp?.ok) throw new Error(resp?.error || `Could not highlight "${id}"`);
      return { ok: true, id };
    }

    // ── Semantic browsing-history search ──────────────────────────────────
    case 'find_history': {
      const query = String(action.query || '').trim();
      if (!query) throw new Error('find_history needs a query');
      const maxResults = Math.min(15, Math.max(1, Number(action.maxResults) || 6));
      const results = await findInHistory(query, { maxResults });
      return {
        ok: true,
        count: results.length,
        semantic: results.some(r => r.semantic),
        results: results.map(r => ({ title: r.title, url: r.url, lastVisitTime: r.lastVisitTime, score: +r.score.toFixed(3) })),
      };
    }

    default:
      // SIH: unknown action types were silently reported {ok:true} — a fake
      // success that poisoned the loop's honest-history invariant.
      throw new Error(`Unknown action type: "${String(action.type || '').slice(0, 40)}"`);
  }
}

// ─── Native tool helpers ───────────────────────────────────────────────────────

async function ensureAgentBookmarkFolder() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree?.[0]?.children?.find(c => !c.url) || tree?.[0]; // "Other bookmarks" usually
  const existing = (root.children || []).find(c => c.title === 'Open Comet' && !c.url);
  if (existing) return existing;
  return chrome.bookmarks.create({ parentId: root.id, title: 'Open Comet' });
}

function normalizeTabUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch { return String(url || ''); }
}

const READING_LIST_KEY = 'opencometReadingList';
const MONITORS_KEY = 'opencometMonitors';

async function getReadingList() {
  const data = await chrome.storage.local.get(READING_LIST_KEY);
  return Array.isArray(data[READING_LIST_KEY]) ? data[READING_LIST_KEY] : [];
}

async function saveReadingList(list) {
  await chrome.storage.local.set({ [READING_LIST_KEY]: list.slice(-200) });
}

async function mergeWithNativeReadingList(list) {
  try {
    if (chrome.readingList?.getAll) {
      const native = await chrome.readingList.getAll();
      const seen = new Set(list.map(i => i.url));
      for (const n of native || []) {
        if (seen.has(n.url)) continue;
        list.push({ url: n.url, title: n.title, addedAt: n.creationTime || Date.now(), native: true });
      }
    }
  } catch { /* readingList API unavailable — storage list only */ }
  return list;
}

export function getMonitors() {
  return chrome.storage.local.get(MONITORS_KEY).then(data => {
    const raw = data[MONITORS_KEY];
    return raw instanceof Map ? raw : new Map(Object.entries(raw || {}));
  });
}

export async function saveMonitors(map) {
  await chrome.storage.local.set({ [MONITORS_KEY]: Object.fromEntries(map) });
}

function monitorIdFor(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Background text fetch for monitor diffing (SW has <all_urls> host permission).
 *  NOTE: DOMParser is unavailable in service workers — strip tags via regex. */
export async function fetchPageText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Fetch ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a use_skill request by id or fuzzy name against library + storage.
 *  Uses the statically imported getAllSkills — dynamic import() is banned in SWs. */
async function resolveSkill(requested) {
  const needle = requested.toLowerCase().replace(/^lib_/, '');
  try {
    const all = await getAllSkills();
    return all.find(s => s.id.toLowerCase() === needle)
        || all.find(s => s.id.toLowerCase().includes(needle))
        || all.find(s => s.name.toLowerCase().includes(needle))
        || null;
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function inject(tabId, fn, ...args) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
    return results?.[0]?.result ?? null;
  } catch (e) {
    console.warn('[Open Comet] Injection failed:', e.message);
    return null;
  }
}

// ── v1.11: collapsed field-group orchestration ──────────────────────────────
// Gmail compose (field log, 25-step failed run): the dialog opens with the
// recipients row COLLAPSED — the visible chip reads "Recipients" and the
// "To" <input> simply does not exist until the chip is clicked (user
// diagnosis, screenshot-confirmed: inactive row → "Recipients", expanded
// row → "To … Cc Bcc"). domClick/domType report needExpand; the SW clicks
// the group toggle (generic vocabulary — no vendor code path), waits for
// the row to render, then retries once.
async function executeClickWithExpansion(tabId, sel, context) {
  let result = await inject(tabId, domClick, sel, context);
  if (result?.ok || !result?.needExpand) return result;
  console.log(`[Open Comet] Field not found (${String(sel).slice(0, 50)}…) — expanding collapsed field group…`);
  const expanded = await inject(tabId, domExpandToggle, result.tokens || []);
  if (!expanded?.ok) return result;
  console.log(`[Open Comet] Expanded "${expanded.label}" — retrying click`);
  await sleep(450);
  const retry = await inject(tabId, domClick, sel, context);
  if (retry?.ok) retry.expandedToggle = expanded.label;
  return retry ?? result;
}

// Failure text that TEACHES: the VLM sees which fields/toggles actually
// exist on the page, so its next decision is informed instead of a re-guess.
function clickFailMessage(result) {
  const base = result?.reason || 'Click failed';
  return result?.inventory ? `${base} — on page: ${result.inventory}` : base;
}

// v1.11: REAL (trusted) click via the DevTools protocol. Some hardened
// widgets ignore synthetic events (isTrusted=false) no matter how realistic
// the event sequence is — Gmail's Send button survived 6 synthetic clicks in
// the field log. chrome.debugger input events are delivered through the
// browser input pipeline exactly like a human click. The debugger banner
// appears briefly; attaching fails cleanly when DevTools owns the tab.
async function trustedClick(tabId, rect) {
  const w = Math.max(1, Math.round(rect?.w || 0));
  const h = Math.max(1, Math.round(rect?.h || 0));
  const x = Math.round((rect?.x || 0) + w / 2);
  const y = Math.round((rect?.y || 0) + h / 2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'no click coordinates' };
  // v1.17.0: chrome.debugger is Chromium-only — Firefox degrades to synthetic
  // clicks with an honest reason instead of a cryptic TypeError.
  if (!chrome.debugger) return { ok: false, reason: 'trusted (debugger) clicks need Chromium — synthetic click attempted on this browser' };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return { ok: false, reason: e?.message || 'debugger attach failed (DevTools open?)' };
  }
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', clickCount: 0 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, x, y };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* already detached */ }
  }
}

function resolveTabId(action, agentState) {
  if (Number.isInteger(action.tabId) && agentState.taskTabIds.includes(action.tabId)) return action.tabId;
  const graph = agentState.taskTabGraph;
  const wantHost  = String(action.host  || '').toLowerCase();
  const wantTitle = String(action.title || '').toLowerCase();
  const wantUrl   = String(action.url   || '').toLowerCase();
  return Object.values(graph).find(tab =>
    (wantHost  && tab.host?.includes(wantHost)) ||
    (wantTitle && tab.title?.toLowerCase().includes(wantTitle)) ||
    (wantUrl   && tab.url?.toLowerCase().includes(wantUrl))
  )?.id ?? null;
}

function getInteractiveContext(action, agentState) {
  const pageInfo = agentState?.lastPageInfo || {};
  const elements = pageInfo.interactiveElements || [];
  const selector = String(action.selector || action.text || action.uid || '');
  const uid = String(action.uid || selector).replace(/^uid:/, '');
  const textSelector = selector.startsWith('text:') ? selector.slice(5) : selector;

  const matched = elements.find(item =>
    item?.uid === uid ||
    item?.selector === selector ||
    (textSelector && item?.text && item.text.toLowerCase() === textSelector.toLowerCase())
  ) || null;

  if (!matched) return null;
  return {
    uid: matched.uid || '',
    text: matched.text || '',
    label: matched.label || '',
    axName: matched.axName || '',
    href: matched.href || '',
    placeholder: matched.placeholder || '',
    domPath: matched.domPath || '',
    ariaLabel: matched.ariaLabel || '',
    bounds: matched.bounds || null,
    editable: Boolean(matched.editable),
  };
}

function getSearchContext(agentState) {
  const pageInfo = agentState?.lastPageInfo || {};
  const elements = pageInfo.interactiveElements || [];
  const searchTerms = ['search', 'find', 'query', 'lookup'];
  const searchCandidates = elements
    .filter(item => item?.editable)
    .filter(item => {
      const haystack = [
        item.text,
        item.label,
        item.axName,
        item.placeholder,
        item.role,
        item.tag,
        item.type,
        item.name,
        item.id,
        item.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchTerms.some(term => haystack.includes(term)) || /\b(qs?|search-input|search-field)\b/.test(haystack);
    })
    .slice(0, 6)
    .map(item => ({
      selector: item.selector,
      uid: item.uid,
      text: item.text || '',
      label: item.label || item.axName || '',
      placeholder: item.placeholder || '',
      bounds: item.bounds || null,
    }));

  return { candidates: searchCandidates };
}

// ─── Page functions injected into tabs ──────────────────────────────────────
// These run inside the page context — no closures over outer scope.

// Cheap page fingerprint used for action verification. Must stay
// self-contained (it is serialized into the page).
//

// ── SIH Phase 16: media STATE probe (before/after for the media action) ─────
// Returns the paused/muted signature of every <video>/<audio> — deliberately
// excludes currentTime (drifts while playing → would fake "changed").
function domMediaState() {
  const grab = (el) => ({ paused: !!el.paused, muted: !!el.muted });
  return [
    ...document.querySelectorAll('video').map(grab),
    ...document.querySelectorAll('audio').map(grab),
  ];
}

// v1.15: mail-send probe host gate. Reads the LIVE tab URL (the state graph
// may be stale) and only allows the compose/toast probe on actual mail hosts,
// so unrelated sites never get "mail send flow advanced" verification copy.
// v1.16.1: EXPORTED — sw.js's auto-done "Email sent successfully" path now
// gates its detectEmailSent() probe behind this same host check (previously
// a click on ANY page whose body text contained the word "sent" could end
// the task with a false "email sent").
export async function isMailHostTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return /(^|\.)mail\.[a-z0-9.-]+\.[a-z]{2,}|^outlook\.(live|office)\.com|^outlook\.com$/i
      .test(String(tab?.url || '').replace(/^https?:\/\//i, '').split('/')[0] || '');
  } catch {
    return false;
  }
}

// ── SIH: mail/compose send-success probe (runs in the PAGE) ──────────────────
// Gmail Send closes the [role=dialog][aria-label="New Message"] window and
// raises an aria-live toast ("Message sent" / "Sending…"). The structural
// fingerprint can miss this during the dialog's teardown animation.
function verifyMailSendOutcome() {
  const dialogsBeforeNow = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')]
    .filter(d => d.getBoundingClientRect().width > 2);
  const composeOpen = dialogsBeforeNow.some(d =>
    /new message|compose/i.test(String(d.getAttribute('aria-label') || '')));
  let toast = '';
  try {
    toast = [...document.querySelectorAll('[aria-live="polite"], [role=status], [aria-live="assertive"]')]
      .map(t => String(t.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join(' | ').slice(0, 120);
  } catch {}
  const sent = /\b(message sent|mail sent|sending)\b/i.test(toast);
  return { composeClosed: !composeOpen, sent, toast };
}

// v1.11: adds DIALOGS + FOCUS + EDITABLE census. The old fingerprint
// (url/title/scroll/videos) was BLIND to in-dialog state: in the field log
// the Gmail compose recipients row expanded ("Recipients" → "To Cc Bcc")
// with zero fingerprint movement, so verified-dead clicks thrashed the VLM
// for 17 steps; and the Send click that actually worked couldn't be told
// apart from the ones that didn't (dialog never closed in the fingerprint).
// SIH v1.14: CONTENT + CONTROL + CANVAS signatures for action verification.
// The structural fingerprint (url/title/scroll/dialogs/focus) is BLIND to the
// most common effect of a successful click: content that appears IN PLACE —
// a result list unhidden, a success message revealed, a tab's inner content
// swapped, a canvas redrawn. Measured false negatives in the E2E benchmark:
// the newsletter "Subscribe" click revealed #f-ok with zero structural
// movement → "NO VISIBLE CHANGE" even though the action succeeded.
//   contentSig — cheap hash of the visible text (normalized, truncated)
//   controls   — count of toggled states (aria-expanded/pressed, :checked)
//   canvasSig  — 8×8 downsample hash of the first canvases (canvas apps)
//
// v1.15 CRITICAL FIX — PAGE-INJECTED FUNCTIONS MUST BE SELF-CONTAINED.
// chrome.scripting.executeScript serializes ONLY the `func` it is handed;
// the four helpers above lived as TOP-LEVEL functions in actions.js, so in
// the page's isolated world `visibleContentSig` / `controlStates` /
// `canvasSigs` / `shortHash` simply did not exist → the injected fingerprint
// threw ReferenceError → inject() resolved null for BEFORE *and* AFTER on
// EVERY page since v1.14. Click verification then ran on the (host-gated in
// v1.15) mail-probe crutch — the user's YouTube field log ("mail send
// signals detected" on a Music-nav click) was this bug talking. The helpers
// now live INSIDE the fingerprint function, matching the self-containment
// convention of every other page-injected function (domClick, domType, …).
function domPageFingerprint() {
  // ── self-contained helpers (serialized with the function) ─────────────────
  function shortHash(str) {
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let i = 0; i < str.length; i++) {
      h1 = ((h1 ^ str.charCodeAt(i)) * 0x01000193) >>> 0;
      if (i % 7 === 0) h2 = ((h2 + str.charCodeAt(i) * (i + 1)) * 31) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  }
  function visibleContentSig() {
    const agentOwned = el => {
      try { return !!(el && el.closest && el.closest('[id^="open-comet-"]')); } catch { return false; }
    };
    try {
      const parts = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (parts.length > 400) break;
          if (agentOwned(el)) continue;
          const tag = el.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          // Leaf-ish content nodes only (keeps the walk cheap)
          if (el.children.length === 0) {
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length >= 2) parts.push(t);
          }
        }
      };
      walk(document.body || document.documentElement);
      return shortHash(parts.join('|').slice(0, 8000));
    } catch { return ''; }
  }
  function controlStates() {
    try {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
      return {
        expanded: [...document.querySelectorAll('[aria-expanded]')].filter(e => e.getAttribute('aria-expanded') === 'true' && vis(e)).length,
        pressed: [...document.querySelectorAll('[aria-pressed]')].filter(e => e.getAttribute('aria-pressed') === 'true' && vis(e)).length,
        checked: [...document.querySelectorAll('input')].filter(e => e.checked && vis(e)).length,
      };
    } catch { return { expanded: -1, pressed: -1, checked: -1 }; }
  }
  function canvasSigs() {
    try {
      return [...document.querySelectorAll('canvas')].slice(0, 3).map(c => {
        try {
          if (c.width < 8 || c.height < 8) return 'tiny';
          const t = document.createElement('canvas');
          t.width = 8; t.height = 8;
          const g = t.getContext('2d');
          g.drawImage(c, 0, 0, 8, 8);
          return shortHash(Array.from(g.getImageData(0, 0, 8, 8).data).join(','));
        } catch { return 'opaque'; }  // cross-origin/tainted canvas — stable marker
      }).join(',');
    } catch { return ''; }
  }

  // ── structural fingerprint ────────────────────────────────────────────────
  const agentOwned = el => {
    try { return !!(el && el.closest && el.closest('#open-comet-agent-overlay,#open-comet-redaction-viz,[id^="open-comet-"]')); }
    catch { return false; }
  };
  const vis = el => {
    if (!el || agentOwned(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const editableCount = root => [...root.querySelectorAll('input,textarea,[contenteditable="true"],[contenteditable=""]')]
    .filter(vis).length;
  const vids = [...document.querySelectorAll('video')].map((v, i) => {
    const r = v.getBoundingClientRect();
    return {
      i,
      paused: v.paused,
      muted: v.muted,
      t: Math.round(v.currentTime * 10) / 10,
      visible: r.width > 2 && r.height > 2,
      area: Math.round(r.width * r.height),
    };
  });
  const dialogs = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')]
    .filter(vis)
    .map((d, i) => {
      const t = String(d.getAttribute('aria-label') || d.textContent || '').replace(/\s+/g, ' ').trim();
      return { i, label: t.slice(0, 60), textLen: t.length, fields: editableCount(d) };
    });
  const ae = document.activeElement;
  const focused = (ae && ae !== document.body && vis(ae)) ? {
    tag: String(ae.tagName || '').toLowerCase(),
    label: String(ae.getAttribute?.('aria-label') || ae.getAttribute?.('placeholder') || '').slice(0, 40),
    editable: !!(ae.isContentEditable || ae.tagName === 'TEXTAREA' ||
      (ae.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'file', 'image'].includes(String(ae.type || '').toLowerCase()))),
  } : null;
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    videos: vids,
    audios: [...document.querySelectorAll('audio')].map(a => ({ paused: a.paused, muted: a.muted })),
    dialogs,
    editables: editableCount(document.body),
    focused,
    // SIH v1.14: content/control/canvas signatures — catch in-place effects
    // (revealed results, success messages, toggles, canvas redraws) that the
    // structural fields cannot see.
    contentSig: visibleContentSig(),
    controls: controlStates(),
    canvasSig: canvasSigs(),
  };
}

// v1.15 NAVIGATION LENS — SW-side helper for the `!after` case (the document
// was mid-navigation, so the in-page fingerprint could not be read). The tab
// itself is the signal: a URL or title change vs the pre-action fingerprint
// is a REAL page change. Returns a verification object or null (keep the
// honest "fingerprint unavailable" verdict). Never called when `after` read
// fine, so it cannot inflate a readable-page verdict.
async function tabNavigationSignal(tabId, before) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return null;
    const urlChanged = String(tab.url || '') !== String(before.url || '');
    const titleChanged = String(tab.title || '') !== String(before.title || '');
    if (!urlChanged && !titleChanged) return null;
    const what = urlChanged
      ? `url ${String(before.url || '').slice(0, 48)} → ${String(tab.url || '').slice(0, 48)}`
      : `title "${String(before.title || '').slice(0, 30)}" → "${String(tab.title || '').slice(0, 30)}"`;
    console.log(`[Open Comet] Verify · tab-level navigation signal → PAGE CHANGED · ${what}`);
    return { changed: true, summary: `navigated (${what}) — read from the tab, post-action fingerprint unavailable`, tabLevel: true };
  } catch {
    return null;   // tab gone — keep the honest no-change verdict
  }
}

// Diff two fingerprints (both may be null if injection failed).
// NOTE: runs in the service worker, NOT in the page.
// SIH: opts.ignoreMediaTime — non-media actions (click/type/key) must not
// treat free-running video currentTime drift as "page changed".
function diffFingerprints(before, after, opts = {}) {
  if (!after) return { changed: false, summary: 'post-action fingerprint unavailable (page busy/navigating?)' };
  if (!before) return { changed: true, summary: 'no baseline — treated as changed' };
  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const scrollChanged = Math.abs((before.scrollY || 0) - (after.scrollY || 0)) > 8;

  let mediaChanged = false;
  const mediaDetails = [];
  const bVids = before.videos || [];
  const aVids = after.videos || [];
  for (let i = 0; i < Math.max(bVids.length, aVids.length); i++) {
    const b = bVids[i], a = aVids[i];
    if (!a) { mediaDetails.push(`video#${i}: removed`); mediaChanged = true; continue; }
    if (!b) { mediaDetails.push(`video#${i}: added (paused=${a.paused})`); mediaChanged = true; continue; }
    if (b.paused !== a.paused) { mediaDetails.push(`video#${i}: ${b.paused ? 'paused' : 'playing'} → ${a.paused ? 'paused' : 'PLAYING'}`); mediaChanged = true; }
    if (b.muted !== a.muted) { mediaDetails.push(`video#${i}: muted=${b.muted} → muted=${a.muted}`); mediaChanged = true; }
    // currentTime drifts while playing — catch "still playing" even if the
    // paused flag was mutated back by the page. SKIPPED for non-media actions
    // (a playing video drifts >0.35s during the 750ms settle sleep and used to
    // fake "PAGE CHANGED" for clicks that did nothing — SIH fix).
    if (!opts.ignoreMediaTime && Math.abs((b.t || 0) - (a.t || 0)) > 0.35) { mediaDetails.push(`video#${i}: time ${b.t} → ${a.t}`); mediaChanged = true; }
  }
  if ((before.audios || []).length !== (after.audios || []).length) mediaChanged = true;

  // ── v1.11: in-dialog signals ───────────────────────────────────────────
  const dialogChanged = JSON.stringify(before.dialogs || []) !== JSON.stringify(after.dialogs || []);
  const bE = before.editables || 0;
  const aE = after.editables || 0;
  const editablesChanged = bE !== aE;
  // Focus only counts when it moved INTO a typeable element — clicking random
  // containers (which focus <body>) must not fake "PAGE CHANGED".
  const focusChanged = !!(after.focused && after.focused.editable) &&
    JSON.stringify(before.focused || null) !== JSON.stringify(after.focused);

  let changed = urlChanged || titleChanged || scrollChanged || mediaChanged || dialogChanged || editablesChanged || focusChanged;
  const parts = [];
  if (urlChanged) parts.push('url');
  if (titleChanged) parts.push('title');
  if (scrollChanged) parts.push(`scroll ${before.scrollY}→${after.scrollY}`);
  if (mediaChanged) parts.push(mediaDetails.join('; ') || 'media');
  if (dialogChanged) parts.push('dialog state changed');
  if (editablesChanged) parts.push(`fields ${bE}→${aE}`);
  if (focusChanged) parts.push(`focus → ${after.focused.tag}${after.focused.label ? ` "${after.focused.label}"` : ''}`);
  // SIH v1.14: content / control-state / canvas signatures. A video's own
  // pixels feed NO signature here (contentSig is text-only), and playing
  // media does not change visible text — so ignoreMediaTime semantics hold.
  let contentChanged = false;
  if ((before.contentSig || '') !== '' && (after.contentSig || '') !== '' &&
      before.contentSig !== after.contentSig) {
    contentChanged = true; changed = true; parts.push('content changed');
  }
  const bc = before.controls || {}, ac = after.controls || {};
  const controlsChanged = (bc.expanded ?? ac.expanded ?? -1) >= 0 &&
    (bc.expanded !== ac.expanded || bc.pressed !== ac.pressed || bc.checked !== ac.checked);
  if (controlsChanged) { changed = true; parts.push(`control state ${JSON.stringify(bc)}→${JSON.stringify(ac)}`); }
  const canvasChanged = (before.canvasSig || after.canvasSig || '') !== '' &&
    before.canvasSig !== after.canvasSig;
  if (canvasChanged) { changed = true; parts.push('canvas content changed'); }
  if (!parts.length) parts.push(`videos=${aVids.length} state unchanged`);
  return { changed, summary: parts.join(' · ') };
}

// Direct playback control over the page's most visible media element.
// Works even when player UI clicks are swallowed by the page (YouTube…).
// v1.9: do NOT drop zero-area <video> elements — YouTube Music keeps its
// player mounted but invisible (0×0) until playback starts, so the old
// area>0 filter reported "No <video> or <audio> element" while
// domPageFingerprint saw videos=1 (field log: 3 wasted VLM rounds).
// Visible elements are still preferred; hidden ones are a fallback.
function domMediaControl(command) {
  const vids = [...document.querySelectorAll('video')]
    .map((v, i) => {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      return { v, i, area, visible: area > 0 && r.width > 2 && r.height > 2 };
    })
    .sort((a, b) => (b.visible - a.visible) || (b.area - a.area));
  const auds = [...document.querySelectorAll('audio')];
  const picked = vids[0] || null;
  const target = picked?.v || auds[0] || null;
  if (!target) return { ok: false, reason: 'No <video> or <audio> element on the page' };

  const state = () => ({ paused: target.paused, muted: target.muted, t: Math.round(target.currentTime * 10) / 10 });
  const before = state();
  try {
    switch (command) {
      case 'pause': target.pause(); break;
      case 'play': { const p = target.play(); if (p?.catch) p.catch(() => {}); break; }
      case 'mute': target.muted = true; break;
      case 'unmute': target.muted = false; break;
      case 'toggle': target.paused ? target.play()?.catch?.(() => {}) : target.pause(); break;
    }
  } catch (e) {
    return { ok: false, reason: `Media ${command} threw: ${e?.message || e}` };
  }
  const r = target.getBoundingClientRect();
  return {
    ok: true,
    command,
    matched: `${target.tagName.toLowerCase()}#${picked ? picked.i : 'audio'} (${Math.round(r.width)}×${Math.round(r.height)}${picked && !picked.visible ? ', hidden' : ''})`,
    hidden: Boolean(picked && !picked.visible),
    before,
    state: state(),
  };
}

function domClick(sel, context = null) {
  // ── shared helpers (self-contained — this function is serialized) ──────
  const escAttr = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const norm    = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // v1.11: NEVER match the extension's own injected UI. Field-log proof: the
  // overlay's status line echoes the current action description, so the old
  // generic text scan matched IT and the agent clicked ITSELF for 17 steps
  // (matched="click \"the to field in the new message window\"").
  const agentOwned = el => {
    try { return !!(el && el.closest && el.closest('#open-comet-agent-overlay,#open-comet-redaction-viz,[id^="open-comet-"]')); }
    catch { return false; }
  };
  const visible = el => {
    if (!el || agentOwned(el)) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const label = el => norm(
    el?.innerText ||
    el?.textContent ||
    el?.getAttribute?.('aria-label') ||
    el?.getAttribute?.('title') ||
    el?.value
  );
  const clickableAncestor = el =>
    el?.closest?.('a, button, [role=button], [role=option], [role=menuitem], input[type=button], input[type=submit], label, summary') || el;

  // ── v1.11 field-aware helpers (mirror of lib/field-matching.js) ────────
  const FIELD_QUERY_RE = /\b(field|input|box|textbox|textarea|editor|recipients?|subject|search bar|search box|email field|password|message body|compose body|body)\b/i;
  const FIELD_STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'in', 'into', 'on', 'at', 'to', 'for',
    'field', 'input', 'box', 'textbox', 'text', 'area', 'element', 'please',
    'window', 'popup', 'pop', 'up', 'dialog', 'panel', 'bar', 'row', 'section',
    'click', 'press', 'type', 'typing', 'enter', 'entering', 'fill', 'filling',
    'then', 'that', 'this', 'with', 'using', 'use', 'again', 'still', 'try',
    'first', 'next', 'top', 'bottom', 'left', 'right', 'large', 'small', 'big',
    'white', 'blue', 'grey', 'gray', 'black', 'red', 'green', 'yellow',
  ]);
  // Dialog/section CONTEXT words — "the To field in the New Message window"
  // must not match the message BODY editor just because it contains the word
  // "Message". They still contribute, but far less than a field-name hit.
  const CONTEXT_WORDS = new Set(['new', 'message', 'compose', 'reply', 'forward', 'draft']);
  // NOTE: 'to' IS a stopword above, but as a FIELD NAME ("To recipients")
  // it matters — keep single letters out and rely on word-boundary scoring:
  // tokens are computed WITHOUT removing 'to' when it stands alone.
  const fieldTokens = desc => String(desc || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w && (w === 'to' || (w.length >= 2 && !FIELD_STOP.has(w))));
  const scoreField = (tokens, hints) => {
    const h = String(hints || '').toLowerCase();
    if (!h || !tokens.length) return 0;
    let s = 0;
    for (const t of tokens) {
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(h)) { s += CONTEXT_WORDS.has(t) ? 1 : 3; continue; }
      if (h.includes(t) && t.length >= 3 && !CONTEXT_WORDS.has(t)) s += 1;
    }
    return s;
  };
  // A lone context-word hit (score 1) is NOT a field match — two field-name
  // points (or one + a weak hit) are required.
  const MIN_FIELD_SCORE = 2;
  const TOGGLE_VOCAB = new Set([
    'recipients', 'to recipients', 'select recipients', 'add recipients',
    'cc', 'bcc', 'add cc', 'add bcc', 'cc bcc',
    'options', 'more options', 'advanced', 'advanced options',
    'details', 'more details', 'add title', 'add description', 'add note',
    'add participants', 'add people', 'invite', 'add invitees', 'filters',
  ]);
  const FORBIDDEN_TOGGLE_RE = /^(send|delete|remove|discard|close|cancel|ok|okay|save|submit|next|done|undo|archive|report|spam|mute|block|reply|forward|print|share|logout|sign out|minimize|maximize|expand|collapse)\b/i;

  const isTypeable = el => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
    if (ce === 'true' || ce === '') return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes((el.type || '').toLowerCase());
  };
  const collectEditables = () => [...document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]')]
    .filter(el => isTypeable(el) && visible(el));
  const hintsOf = el => norm([
    el.getAttribute?.('aria-label'), el.getAttribute?.('placeholder'),
    el.getAttribute?.('name'), el.id, el.getAttribute?.('title'),
  ].filter(Boolean).join(' '));
  const findField = toks => {
    let best = null, bestScore = MIN_FIELD_SCORE;
    for (const el of collectEditables()) {
      const s = scoreField(toks, hintsOf(el));
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best ? { el: best, score: bestScore } : null;
  };
  // Inventory of what IS on the page — attached to failures so the VLM's next
  // decision is informed ("No input matched" + "fields present: …").
  const inventoryLine = () => {
    try {
      const fields = collectEditables().slice(0, 6).map(el => {
        const l = el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.getAttribute?.('name') || el.id || '';
        const kind = el.tagName === 'INPUT' ? 'input' : el.tagName === 'TEXTAREA' ? 'input' : 'editor';
        return `${(l || 'unlabeled').slice(0, 30)} (${kind})`;
      });
      // toggles are only meaningful INSIDE a dialog — scanning the whole page
      // (no dialog) would be O(page) for no signal.
      const scopes = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible);
      const root = scopes[0] || null;
      const toggles = root
        ? [...root.querySelectorAll('[role=button],button,div,span,li')].slice(0, 800)
          .filter(el => visible(el) && !el.querySelector('input,textarea,button,[role=button],[contenteditable]'))
          .map(el => norm(el.textContent || ''))
          .filter(l => l && l.length >= 2 && l.length <= 24 && TOGGLE_VOCAB.has(l))
          .slice(0, 4)
        : [];
      const bits = [];
      if (fields.length) bits.push(`fields: ${fields.join(', ')}`);
      if (toggles.length) bits.push(`collapsed group labels: ${toggles.join(', ')}`);
      return bits.join(' · ');
    } catch { return ''; }
  };

  const press = target => {
    target.scrollIntoView({ block: 'center', inline: 'center' });
    const r = target.getBoundingClientRect();
    const clientX = r.left + Math.min(r.width - 2, Math.max(2, r.width / 2));
    const clientY = r.top + Math.min(r.height - 2, Math.max(2, r.height / 2));
    ['pointerover', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY }))
    );
    if (typeof target.click === 'function') target.click();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const pools = [
    ...document.querySelectorAll('a, button, [role=button], input[type=button], input[type=submit], label, summary'),
    ...document.querySelectorAll('[role=option], [role=menuitem], [role=listitem], [role=row], [role=gridcell], [role=tab], [role=treeitem], li'),
  ];

  // ── v1.9: SCORED text matching ────────────────────────────────────────
  // The old finder took the FIRST partial match in document order, so the
  // needle "play" matched the sidebar button "New playlist"
  // ("new playlist".includes("play") is true) and the click OPENED A DIALOG
  // that blocked the page for 3 VLM rounds. Candidates are now scored:
  //   exact label           = 100
  //   word-boundary match   =  70  ("play" matches "Play" or "Play button",
  //                                  NOT "playlist" — no word boundary)
  //   startsWith            =  55
  //   plain substring       =  35
  // minus a small penalty for LONG labels (shorter labels are more precise),
  // and interactive-pool elements always outrank generic ones at equal score.
  // v1.11: overlay/agent-owned elements are excluded via visible().
  const scoreMatch = (labelText, needle) => {
    if (!labelText || !needle) return -1;
    if (labelText === needle) return 100;
    let score = -1;
    try {
      if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(labelText)) score = 70;
    } catch { score = -1; }
    if (score < 0 && labelText.startsWith(needle)) score = 55;
    if (score < 0 && labelText.includes(needle)) score = 35;
    if (score < 0) return -1;
    return score - Math.min(15, Math.floor(labelText.length / 6));
  };

  const findBest = (text, elements) => {
    const t = norm(text);
    if (!t) return null;
    let best = null, bestScore = -1;
    for (const el of elements) {
      if (!visible(el)) continue;
      const s = scoreMatch(label(el), t);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore >= 0 ? best : null;
  };

  const byText = text => {
    const poolHit = findBest(text, pools);
    if (poolHit) return poolHit;
    // Generic fallback: scan leaf-ish elements with the SAME scoring so a
    // div named "New playlist" can no longer beat a real button.
    // v1.11: additionally exclude BODY/HTML and ANY element that CONTAINS
    // agent-owned UI — containers whose innerText includes the overlay's
    // action echo used to win the substring match (the field-log "matched=
    // click \"the to field…\"" self-click ran through exactly this hole).
    let agentRoots = null;
    const containsAgentUI = el => {
      try {
        if (!agentRoots) agentRoots = [...document.querySelectorAll('[id^="open-comet-"]')];
        return agentRoots.some(rt => rt !== el && el.contains(rt));
      } catch { return false; }
    };
    return findBest(text, [...document.querySelectorAll('*')].filter(el =>
      el.children.length <= 8 &&
      el.tagName !== 'BODY' && el.tagName !== 'HTML' &&
      !agentOwned(el) && !containsAgentUI(el)
    )) || null;
  };

  const byHref = href => {
    const targetHref = String(href || '').trim();
    if (!targetHref) return null;
    return [...document.querySelectorAll('a[href]')].find(el => visible(el) && (el.href === targetHref || el.href.includes(targetHref))) || null;
  };
  const byDomPath = domPath => {
    const path = String(domPath || '').trim();
    if (!path) return null;
    try {
      const el = document.querySelector(path);
      return visible(el) ? el : null;
    } catch {
      return null;
    }
  };

  const byBounds = bounds => {
    if (!bounds) return null;
    const x = Math.max(1, Math.min(window.innerWidth - 1, Math.round(bounds.x + Math.max(4, bounds.w / 2))));
    const y = Math.max(1, Math.min(window.innerHeight - 1, Math.round(bounds.y + Math.max(4, bounds.h / 2))));
    const hit = document.elementFromPoint(x, y);
    return visible(hit) ? hit : null;
  };
  const byCoordinates = (x, y) => {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return null;
    const hit = document.elementFromPoint(Number(x), Number(y));
    return visible(hit) ? hit : null;
  };

  let element = null;
  let resolution = '';
  let rect = null;
  const tokens = fieldTokens(String(sel || '').startsWith('text:') ? String(sel).slice(5) : sel);
  const uid = String(sel).match(/^uid:(.+)$/);
  if (uid) {
    element = document.querySelector('[data-opencomet-agent-uid="' + escAttr(uid[1]) + '"]');
    if (element) resolution = 'uid';
  } else if (String(sel).startsWith('text:')) {
    element = byText(String(sel).slice(5));
    if (element) resolution = 'text';
  } else {
    try {
      const q = document.querySelector(sel);
      if (q && visible(q)) { element = q; resolution = 'css'; }
    } catch {}
    if (!element) {
      // v1.11: VLMs quote the on-screen label — "the blue 'Send' button" —
      // try that quoted span as exact text before anything else.
      const quoted = (String(sel).match(/['"“]([^'"“]{1,60})['"”]/) || [])[1];
      if (quoted) {
        element = byText(quoted.trim());
        if (element) resolution = 'quoted';
      }
    }
    if (!element && FIELD_QUERY_RE.test(String(sel))) {
      // Field-aware resolution: fuzzy-match editables by hints; when the
      // field doesn't exist, report needExpand so the SW can click the
      // collapsed group chip ("Recipients") and retry.
      const hit = findField(tokens);
      if (hit) { element = hit.el; resolution = 'field'; }
    }
    if (!element) {
      const t = byText(sel);
      if (t) { element = t; resolution = 'text-scan'; }
    }
  }

  if ((!element || !visible(element)) && context) {
    if (context.uid) {
      element = document.querySelector('[data-opencomet-agent-uid="' + escAttr(context.uid) + '"]');
    }
    if ((!element || !visible(element)) && context.x != null && context.y != null) element = byCoordinates(context.x, context.y);
    if ((!element || !visible(element)) && context.href) element = byHref(context.href);
    if ((!element || !visible(element)) && context.domPath) element = byDomPath(context.domPath);
    if ((!element || !visible(element)) && context.label) element = byText(context.label);
    if ((!element || !visible(element)) && context.axName) element = byText(context.axName);
    if ((!element || !visible(element)) && context.text) element = byText(context.text);
    if ((!element || !visible(element)) && context.bounds) element = byBounds(context.bounds);
    if ((!element || !visible(element)) && context.placeholder) element = byText(context.placeholder);
  }

  if (!element || !visible(element)) {
    const inventory = inventoryLine();
    return {
      ok: false,
      reason: 'No clickable element matched: ' + sel,
      // field-like queries may succeed after expanding a collapsed group
      needExpand: FIELD_QUERY_RE.test(String(sel)) && collectEditables().length <= 10,
      tokens,
      ...(inventory ? { inventory } : {}),
    };
  }

  let target = clickableAncestor(element);
  if (!visible(target) && context?.bounds) {
    const fallback = byBounds(context.bounds);
    target = clickableAncestor(fallback);
  }

  rect = press(target);

  return {
    ok: true,
    matchedText: label(target).substring(0, 120),
    resolution,
    href: target.href || target.closest?.('a')?.href || '',
    rect,
  };
}

// ── v1.11: click a COLLAPSED FIELD-GROUP toggle so hidden inputs appear ─────
// Gmail compose: the "Recipients" chip → clicking it creates the To <input>
// ("To … Cc Bcc" row). Generic vocabulary + query-token overlap; destructive
// labels are hard-excluded. Self-contained (serialized into the page).
function domExpandToggle(tokens = []) {
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const agentOwned = el => {
    try { return !!(el && el.closest && el.closest('#open-comet-agent-overlay,#open-comet-redaction-viz,[id^="open-comet-"]')); }
    catch { return false; }
  };
  const visible = el => {
    if (!el || agentOwned(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const TOGGLE_VOCAB = new Set([
    'recipients', 'to recipients', 'select recipients', 'add recipients',
    'cc', 'bcc', 'add cc', 'add bcc', 'cc bcc',
    'options', 'more options', 'advanced', 'advanced options',
    'details', 'more details', 'add title', 'add description', 'add note',
    'add participants', 'add people', 'invite', 'add invitees', 'filters',
  ]);
  const FORBIDDEN_TOGGLE_RE = /^(send|delete|remove|discard|close|cancel|ok|okay|save|submit|next|done|undo|archive|report|spam|mute|block|reply|forward|print|share|logout|sign out|minimize|maximize|expand|collapse)\b/i;
  const toks = (Array.isArray(tokens) ? tokens : []).map(norm).filter(Boolean);
  const ownText = el => norm([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ')) || norm(el.textContent || '');
  const depth = el => { let d = 0, c = el; while (c && c !== document.body) { d++; c = c.parentElement; } return d; };
  const isToggle = l => {
    if (!(l.length >= 2 && l.length <= 24 && /^[a-z][a-z0-9' ]*$/.test(l))) return false;
    if (FORBIDDEN_TOGGLE_RE.test(l)) return false;
    if (TOGGLE_VOCAB.has(l)) return true;
    return toks.some(t => t.length >= 3 && (l === t || l.includes(t) || t.includes(l)));
  };

  const scopes = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible);
  const roots = scopes.length ? scopes : [document.body];
  // Only bother inside compact dialogs/forms — never blaze through huge pages.
  const editableCount = roots.reduce((n, r) => n + [...r.querySelectorAll('input,textarea,[contenteditable="true"],[contenteditable=""]')].filter(visible).length, 0);
  if (editableCount > 12) return { ok: false, reason: 'too many fields — not auto-expanding' };

  const candidates = [];
  for (const root of roots) {
    for (const el of [...root.querySelectorAll('[role=button],button,div,span,li,a')].slice(0, 2500)) {
      if (!visible(el)) continue;
      if (el.querySelector('input,textarea,button,[role=button],[contenteditable="true"]')) continue;
      const lbl = ownText(el);
      if (!lbl || !isToggle(lbl)) continue;
      candidates.push({ el, lbl, d: depth(el), vocab: TOGGLE_VOCAB.has(lbl) });
    }
  }
  // innermost chip wins (wrapper rows share the same text); vocabulary hits
  // beat token-overlap hits.
  candidates.sort((a, b) => (b.vocab - a.vocab) || (b.d - a.d));
  const pick = candidates[0];
  if (!pick) return { ok: false };

  const r = pick.el.getBoundingClientRect();
  const clientX = r.left + Math.min(r.width - 2, Math.max(2, r.width / 2));
  const clientY = r.top + Math.min(r.height - 2, Math.max(2, r.height / 2));
  ['pointerover', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type =>
    pick.el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY }))
  );
  if (typeof pick.el.click === 'function') pick.el.click();
  return { ok: true, label: pick.lbl };
}

// ─── domType: handles <input>, <textarea>, AND contenteditable divs ──────────
//
// KEY FIX: Gmail's compose body is a contenteditable div. Setting .value or
// .textContent on it breaks Gmail's internal React state and the type silently
// fails. The fix is to use document.execCommand('insertText') which routes
// through the browser's native editing pipeline, keeping editor state intact.
//
function domType(sel, val, context = null) {
  const norm    = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const queryDomPath = domPath => {
    const path = String(domPath || '').trim();
    if (!path) return null;
    try {
      const el = document.querySelector(path);
      return el && visible(el) ? el : null;
    } catch {
      return null;
    }
  };

  // ── Is this element something we can type into? ──────────────────────────
  const isEditable = el => {
    if (!el) return false;
    // contenteditable in any form
    if (el.isContentEditable) return true;
    const ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
    if (ce === 'true' || ce === '') return true;
    // textarea
    if (el.tagName === 'TEXTAREA') return true;
    // input (exclude non-typeable types)
    if (el.tagName !== 'INPUT') return false;
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'range', 'color']
      .includes((el.type || '').toLowerCase());
  };

  // All visible editable elements on the page
  const editables = [
    ...document.querySelectorAll(
      'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]'
    )
  ].filter(el => isEditable(el) && visible(el));

  // ── Resolve the target element ────────────────────────────────────────────
  let element = null;
  const escAttr = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // v1.11: "focused" — type into whatever currently has focus. Newly opened
  // dialogs (Gmail compose, share sheets, search overlays) focus their first
  // field, so this is the cheapest reliable path right after opening one.
  if (/^\s*(focused|focus|active ?element|current (field|input))\s*$/i.test(String(sel))) {
    const ae = document.activeElement;
    if (ae && isEditable(ae) && visible(ae)) element = ae;
    else element = ae?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]') || null;
  }

  const uidM = !element && String(sel).match(/^uid:(.+)$/);
  if (uidM) {
    // Primary: the element with that UID
    const byUid = document.querySelector('[data-opencomet-agent-uid="' + escAttr(uidM[1]) + '"]');
    if (byUid && isEditable(byUid) && visible(byUid)) {
      element = byUid;
    } else if (byUid) {
      // If the UID element is a container (e.g. a wrapper div), look for an
      // editable child inside it (common in rich-text editors).
      const child = byUid.querySelector(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]'
      );
      if (child && isEditable(child) && visible(child)) element = child;
    }
  } else if (!element && String(sel).startsWith('text:')) {
    const txt = norm(String(sel).slice(5));
    element = editables.find(el =>
      norm(el.placeholder || el.getAttribute?.('aria-label') || '').includes(txt)
    ) || null;
  } else if (!element) {
    try { element = document.querySelector(sel); } catch {}
    if (element && (!isEditable(element) || !visible(element))) element = null;
  }

  // ── SIH: Gmail PeopleKit / focus-state-agnostic recipient targeting ─────
  // Gmail's recipient <input> swaps its aria-label/placeholder between
  // "Recipients" (inactive) and "To" / "To recipients" (active/focused) —
  // the field log showed 8 selector guesses failing for exactly this reason.
  // Match BOTH states (plus peoplekit-id / combobox signals), scoped to the
  // open dialog first so an inbox search box can never shadow it.
  if (!element) {
    const wantBcc = /\bbcc\b/i.test(sel);
    const wantCc = !wantBcc && /\bcc\b/i.test(sel);
    const wantRecip = /(\brecipients?\b|\bto\b(?!:)|\brecipient field\b|\bto field\b|\bemail field\b)/i.test(sel) && !wantCc && !wantBcc;
    if (wantRecip || wantCc || wantBcc) {
      const RE = wantBcc ? /\bbcc\b/i : wantCc ? /\bcc\b(?!\b(bcc))/i : /\b(to|recipients?)\b/i;
      const scopes = [
        ...document.querySelectorAll('[role=dialog],[aria-modal=true]'),
        document,
      ];
      outer: for (const scope of scopes) {
        const cands = [...scope.querySelectorAll('input, textarea, [role=combobox]')]
          .filter(el => isEditable(el) || String(el.getAttribute('role') || '') === 'combobox')
          .filter(visible);
        for (const el of cands) {
          const blob = [
            el.getAttribute?.('aria-label'), el.getAttribute?.('placeholder'),
            el.getAttribute?.('peoplekit-id'), el.name, el.id,
          ].map(v => String(v || '')).join(' ');
          if (RE.test(blob)) { element = el; break outer; }
        }
      }
    }
  }

  // ── v1.11 fuzzy field matching ────────────────────────────────────────────
  // Old fallback required EVERY token of the description to appear in the
  // hints of ONE element — "the To field in the New Message compose window"
  // could never match anything. Now: stopword-filtered tokens are SCORED
  // against each editable's aria-label/placeholder/name/id; best score wins.
  // Field-log effect: "To field" finds Gmail's input[aria-label="To recipients"].
  if (!element) {
    const FIELD_STOP = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'in', 'into', 'on', 'at', 'for',
      'field', 'input', 'box', 'textbox', 'text', 'area', 'element', 'please',
      'window', 'popup', 'pop', 'up', 'dialog', 'panel', 'bar', 'row', 'section',
      'click', 'press', 'type', 'typing', 'enter', 'entering', 'fill', 'filling',
      'then', 'that', 'this', 'with', 'using', 'use', 'again', 'still', 'try',
      'first', 'next', 'top', 'bottom', 'left', 'right', 'large', 'small', 'big',
      'white', 'blue', 'grey', 'gray', 'black', 'red', 'green', 'yellow',
      'value', 'string', 'characters',
    ]);
    const rawTokens = norm(sel).split(' ').filter(Boolean);
    const tokens = rawTokens.filter(w => w === 'to' || (w.length >= 2 && !FIELD_STOP.has(w)));
    // Dialog/section context words can't carry a match on their own (see
    // domClick CONTEXT_WORDS note — Gmail's body editor aria-label is
    // "Message Body" and the query usually mentions the "New Message" window).
    const CONTEXT_WORDS = new Set(['new', 'message', 'compose', 'reply', 'forward', 'draft']);
    if (tokens.length) {
      let best = null, bestScore = 1;   // require ≥2: a real field-name hit
      for (const el of editables) {
        const hints = [
          el.placeholder,
          el.getAttribute ? el.getAttribute('aria-label') : '',
          el.getAttribute ? el.getAttribute('aria-labelledby') : '',
          el.name, el.id,
        ].map(h => norm(h || '')).join(' ');
        if (!hints) continue;
        let s = 0;
        for (const t of tokens) {
          const re = new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
          if (re.test(hints)) { s += CONTEXT_WORDS.has(t) ? 1 : 3; continue; }
          if (hints.includes(t) && t.length >= 3 && !CONTEXT_WORDS.has(t)) s += 1;
        }
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (best) element = best;
    }
  }

  if (!element && context?.domPath) {
    const domPathMatch = queryDomPath(context.domPath);
    if (domPathMatch && isEditable(domPathMatch)) {
      element = domPathMatch;
    } else if (domPathMatch) {
      element = domPathMatch.querySelector?.('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]') || null;
    }
  }

  if (!element && context) {
    const hintText = [context.label, context.axName, context.placeholder, context.text, context.ariaLabel]
      .map(norm)
      .find(Boolean);
    if (hintText) {
      element = editables.find(el => {
        const hints = [
          el.placeholder,
          el.getAttribute ? el.getAttribute('aria-label') : '',
          el.getAttribute ? el.getAttribute('aria-labelledby') : '',
          el.name,
          el.id,
        ].map(h => norm(h || '')).join(' ');
        return Boolean(hints) && (hints.includes(hintText) || hintText.includes(hints));
      }) || null;
    }
  }

  // ── v1.11 failure → teach, don't dead-end ────────────────────────────────
  if (!element) {
    // Inventory: which fields/toggles ARE present (drives the VLM's next try)
    let inventory = '';
    try {
      const fields = editables.slice(0, 6).map(el => {
        const l = el.getAttribute?.('aria-label') || el.placeholder || el.getAttribute?.('name') || el.id || '';
        const kind = el.tagName === 'INPUT' ? 'input' : el.tagName === 'TEXTAREA' ? 'input' : 'editor';
        return `${(l || 'unlabeled').slice(0, 30)} (${kind})`;
      });
      const bits = [];
      if (fields.length) bits.push(`fields: ${fields.join(', ')}`);
      // collapsed group labels inside a dialog (Gmail: "Recipients" chip)
      const dlg = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible)[0] || null;
      if (dlg) {
        const TOGGLE_VOCAB = new Set([
          'recipients', 'to recipients', 'select recipients', 'add recipients',
          'cc', 'bcc', 'add cc', 'add bcc', 'cc bcc',
          'options', 'more options', 'advanced', 'advanced options',
          'details', 'more details', 'add title', 'add description', 'add note',
          'add participants', 'add people', 'invite', 'add invitees', 'filters',
        ]);
        const toggles = [...dlg.querySelectorAll('[role=button],button,div,span,li')].slice(0, 800)
          .filter(el => visible(el) && !el.querySelector('input,textarea,button,[role=button],[contenteditable]'))
          .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase())
          .filter(l => l && l.length >= 2 && l.length <= 24 && TOGGLE_VOCAB.has(l))
          .slice(0, 4);
        if (toggles.length) bits.push(`collapsed group labels: ${toggles.join(', ')}`);
      }
      inventory = bits.join(' · ');
    } catch { inventory = ''; }
    // field-like queries may succeed after expanding a collapsed group
    const FIELD_QUERY_RE = /\b(field|input|box|textbox|textarea|editor|recipients?|subject|search bar|search box|email field|password|message body|compose body|body)\b/i;
    const rawTokens = norm(sel).split(' ').filter(w => w && (w === 'to' || w.length >= 2));
    return {
      ok: false,
      reason: 'No input matched: ' + sel,
      needExpand: FIELD_QUERY_RE.test(String(sel)) && editables.length <= 12,
      tokens: rawTokens,
      ...(inventory ? { inventory } : {}),
    };
  }

  element.scrollIntoView({ block: 'center' });
  element.focus();

  // ── Branch A: contenteditable (Gmail compose, Outlook, Slack, Notion…) ───
  const isContentEditable =
    element.isContentEditable ||
    element.getAttribute?.('contenteditable') === 'true' ||
    element.getAttribute?.('contenteditable') === '';

  if (isContentEditable) {
    // Check if the element has real text. Use textContent ONLY — not innerHTML,
    // because Gmail's placeholder is literally <br> which has no textContent
    // but non-empty innerHTML, causing false "non-empty" detection that led to
    // all type calls appending instead of replacing.
    const isEmpty = !element.textContent?.trim();

    const winSel = window.getSelection();

    if (winSel) {
      const range = document.createRange();
      if (isEmpty) {
        // Element empty → position caret at start (will insert at position 0)
        range.setStart(element, 0);
        range.collapse(true);
      } else {
        // Element has content → move caret to very end so we APPEND
        range.selectNodeContents(element);
        range.collapse(false); // false = collapse to END
      }
      winSel.removeAllRanges();
      winSel.addRange(range);
    }

    // execCommand('insertText') fires through the browser's native editing
    // pipeline — React, Vue, and Gmail's own editor all see it as real input.
    let typed = false;
    try {
      typed = document.execCommand('insertText', false, val);
    } catch (_) {}

    if (!typed) {
      // Fallback: for empty elements only, clear and inject textNode + InputEvent
      if (isEmpty) element.innerHTML = '';
      element.focus();
      const textNode = document.createTextNode(val);
      if (isEmpty) {
        element.appendChild(textNode);
      } else {
        // Find last text node and append, or add a new node at end
        let last = element.lastChild;
        if (last && last.nodeType === 3) {
          last.textContent += val;
        } else {
          element.appendChild(textNode);
        }
      }
      try {
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true,
          inputType: 'insertText', data: val,
        }));
      } catch (_) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // Generic listeners
    element.dispatchEvent(new Event('input',  { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    // Always move caret to end after insert
    try {
      const ws2 = window.getSelection();
      if (ws2) {
        const r2 = document.createRange();
        r2.selectNodeContents(element);
        r2.collapse(false);
        ws2.removeAllRanges();
        ws2.addRange(r2);
      }
    } catch (_) {}

    // SIH Phase 16: report field metadata so the loop can mask typed
    // secrets in history before they reach the next prompt.
    return { ok: true, method: 'contenteditable', appended: !isEmpty,
      fieldType: 'contenteditable', fieldSensitive: false, verified: true };
  }

  // ── Branch B: standard <input> / <textarea> ───────────────────────────────
  const proto  = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, val);
  else if ('value' in element) element.value = val;
  else element.textContent = val;

  element.dispatchEvent(new Event('input',  { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // ── SIH Phase 16: READ-BACK VERIFICATION — the old code reported ok without
  // checking the value landed. React-controlled fields can silently revert;
  // the VLM then built on a field it believed was filled.
  const fieldType = String(element.type || element.tagName || '').toLowerCase();
  const fieldSensitive = fieldType === 'password'
    || /\b(otp|cvv|cvc|csc|ssn|aadhaar|pin)\b/i.test(String(element.getAttribute?.('autocomplete') || ''))
    || /(password|passwd|otp|cvv|cvc|csc|secret)/i.test(String(element.name || '') + String(element.id || ''));
  let verified;
  try {
    const cur = String(element.value ?? element.textContent ?? '');
    verified = fieldType === 'password'
      ? cur.length > 0
      : cur === String(val) || (cur.length > 0 && String(val).length > 0 && cur.includes(String(val)));
  } catch { verified = false; }
  return { ok: true, method: 'input', fieldType, fieldSensitive, verified };
}

// v1.11: modifier-combo support. The old implementation treated
// "Control+Enter" as a single key name and dispatched a nonsense
// KeyboardEvent(key="Control+Enter") — so the VLM could never use the
// universal "Ctrl+Enter sends the compose" escape hatch (Gmail field log:
// 6 failed Send clicks with no keyboard path available).
function domKey(key) {
  const raw = String(key || '').trim();
  const ALIAS = {
    return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape',
    tab: 'Tab', space: ' ', spacebar: ' ', ctrl: 'Control', control: 'Control',
    cmd: 'Meta', meta: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta',
    alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    backspace: 'Backspace', del: 'Delete', delete: 'Delete', esc_key: 'Escape',
  };
  const MODS = new Set(['Control', 'Meta', 'Alt', 'Shift']);
  const parts = raw.split(/[+\-\s]+/).map(p => p.trim()).filter(Boolean);
  const mods = new Set();
  let main = '';
  for (const p of parts) {
    const canon = ALIAS[p.toLowerCase()] || p;
    if (MODS.has(canon)) mods.add(canon);
    else main = canon.length === 1 ? canon.toUpperCase() : canon;
  }
  if (!main) main = 'Enter';
  const el = document.activeElement || document.body;
  const code = main.length === 1 ? 'Key' + main.toUpperCase() : main;
  const init = {
    key: main, code, bubbles: true, cancelable: true, view: window,
    ctrlKey: mods.has('Control'), metaKey: mods.has('Meta'),
    altKey: mods.has('Alt'), shiftKey: mods.has('Shift'),
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (main === 'Enter' && mods.size === 0) el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  // Legacy helper: plain Enter submits the surrounding <form> (only when no
  // modifiers — combo shortcuts like Ctrl+Enter are app-level, not submit).
  if (main === 'Enter' && mods.size === 0) {
    const form = el.closest?.('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }
  return { ok: true, key: raw, resolved: { key: main, modifiers: [...mods] } };
}

function domSubmit(sel) {
  let target = null;
  if (sel) { try { target = document.querySelector(sel); } catch {} }
  const form = target?.closest?.('form') || document.activeElement?.closest?.('form') || document.querySelector('form');
  if (!form) return { ok: false, reason: 'No form found' };
  form.requestSubmit ? form.requestSubmit() : form.submit();
  return { ok: true };
}
function domScroll(dir, px) {
  const visible = el => {
    const r = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && r.display !== 'none' && r.visibility !== 'hidden';
  };
  const candidates = [document.scrollingElement || document.documentElement, ...document.querySelectorAll('*')]
    .filter(el => {
      if (!el || !visible(el)) return false;
      const style = getComputedStyle(el);
      return (el.scrollHeight - el.clientHeight) > 80 && /(auto|scroll|overlay)/.test(style.overflowY || '');
    })
    .map(el => {
      const rect = el.getBoundingClientRect();
      return { el, area: Math.max(0,Math.min(rect.width,innerWidth)) * Math.max(0,Math.min(rect.height,innerHeight)) };
    })
    .sort((a, b) => b.area - a.area);

  const scroller = candidates[0]?.el || document.scrollingElement || document.documentElement;
  const isDoc    = scroller === document.body || scroller === document.documentElement || scroller === document.scrollingElement;
  const before   = isDoc ? scrollY : scroller.scrollTop;
  const amount   = Math.max(200, px || 600);
  const target   = dir === 'bottom' ? scroller.scrollHeight : dir === 'top' ? 0 : before + (dir === 'up' ? -amount : amount);

  if (isDoc) window.scrollTo({ top: target, behavior: 'auto' });
  else scroller.scrollTop = target;

  const after  = isDoc ? scrollY : scroller.scrollTop;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return {
    ok: true, before, after,
    moved:    Math.abs(after - before),
    atTop:    after <= 4,
    atBottom: after >= maxTop - 4,
    target:   isDoc ? 'document' : (scroller.tagName.toLowerCase() + (scroller.id ? '#' + scroller.id : '')),
  };
}

function domScrollToUid(uid) {
  const escAttr = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const el = document.querySelector('[data-opencomet-agent-uid="' + escAttr(uid) + '"]');
  if (!el) return { ok: false, reason: 'uid not found: ' + uid };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  return { ok: true };
}

function domScrollToText(text) {
  const target = String(text || '').trim().toLowerCase();
  if (!target) return { ok: false, reason: 'No text provided' };
  const match = [...document.querySelectorAll('body *')].find(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.textContent?.toLowerCase().includes(target);
  });
  if (!match) return { ok: false, reason: 'Text not visible: ' + text };
  match.scrollIntoView({ block: 'center', inline: 'nearest' });
  return { ok: true };
}

async function domSearch(query, context = null) {
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const isEditable = el => {
    if (!el) return false;
    if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '') return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes((el.type || '').toLowerCase());
  };
  const scoreEl = el => {
    const hints = [
      el.type,
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('role'),
      el.getAttribute?.('title'),
      el.className,
    ].map(norm).join(' ');
    let score = 0;
    if ((el.type || '').toLowerCase() === 'search') score += 6;
    if (hints.includes('search')) score += 5;
    if (hints.includes('find')) score += 4;
    if (hints.includes('query')) score += 3;
    if (/\bqs?\b/.test(hints)) score += 3;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.45) score += 2;
    if (rect.width > 120) score += 1;
    return score;
  };
  const nativeSet = (el, value) => {
    if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '') {
      el.focus();
      document.execCommand?.('selectAll', false);
      try { document.execCommand?.('insertText', false, value); } catch {}
      if (!el.textContent?.includes(value)) el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let searchEl = null;
  const candidateSelectors = (context?.candidates || []).map(candidate => candidate?.selector).filter(Boolean);
  for (const selector of candidateSelectors) {
    const uid = selector.startsWith('uid:') ? selector.slice(4) : '';
    let candidate = null;
    if (uid) {
      candidate = document.querySelector('[data-opencomet-agent-uid="' + uid.replace(/"/g, '\\"') + '"]');
    } else {
      try { candidate = document.querySelector(selector); } catch {}
    }
    if (visible(candidate)) {
      searchEl = candidate;
      break;
    }
  }

  if (!searchEl) {
    const pools = [
      ...document.querySelectorAll('input, textarea, [contenteditable], [role="searchbox"], [role="textbox"], button, a'),
    ].filter(visible);
    searchEl = pools.sort((a, b) => scoreEl(b) - scoreEl(a))[0] || null;
  }

  if (!searchEl) return { ok: false, reason: 'No search input found' };

  if (!isEditable(searchEl)) {
    searchEl.click();
    await new Promise(res => setTimeout(res, 400));
    const fresh = [
      ...document.querySelectorAll('input, textarea, [contenteditable], [role="searchbox"], [role="textbox"]'),
    ].filter(el => visible(el) && isEditable(el));
    searchEl = fresh.sort((a, b) => scoreEl(b) - scoreEl(a))[0] || searchEl;
  }

  if (!isEditable(searchEl)) return { ok: false, reason: 'Found search trigger but no editable input appeared' };

  searchEl.scrollIntoView({ block: 'center' });
  searchEl.focus();
  nativeSet(searchEl, query);

  const form = searchEl.closest('form');
  const submitButton = form?.querySelector('button[type=submit], input[type=submit], button[aria-label*=search i], button[title*=search i], #search-icon-legacy') || null;

  searchEl.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', code: 'Enter', bubbles: true }));
  searchEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
  searchEl.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Enter', code: 'Enter', bubbles: true }));

  if (submitButton && typeof submitButton.click === 'function') {
    submitButton.click();
  } else if (form) {
    form.requestSubmit ? form.requestSubmit() : form.submit();
  }

  return {
    ok: true,
    matchedSelector: searchEl.id ? `#${searchEl.id}` : searchEl.name ? `[name="${searchEl.name}"]` : searchEl.tagName.toLowerCase(),
  };
}

export function describeAction(action) {
  const map = {
    navigate:       () => 'Navigate → ' + action.url,
    click:          () => 'Click "' + (action.selector || action.text) + '"',
    type:           () => 'Type "' + String(action.text || action.value || '').substring(0, 40) + '" into ' + action.selector,
    fill:           () => 'Fill "' + action.selector + '" ← "' + String(action.text || action.value || '').substring(0, 30) + '"',
    scroll:         () => 'Scroll ' + action.direction + ' ' + (action.amount || 600) + 'px',
    scroll_to_uid:  () => 'Scroll to uid:' + (action.uid || action.selector),
    scroll_to_text: () => 'Scroll to "' + (action.text || action.selector) + '"',
    search:         () => 'Search "' + action.query + '"',
    press_key:      () => 'Press ' + action.key,
    key:            () => 'Press ' + action.key,
    submit:         () => 'Submit form',
    media:          () => 'Media ' + (action.command || 'pause') + ' (direct playback control)',
    media_control:  () => 'Media ' + (action.command || 'pause') + ' (direct playback control)',
    wait:           () => 'Wait ' + ((action.ms || 2000) / 1000) + 's',
    extract:        () => 'Extract "' + action.selector + '"',
    new_tab:        () => 'New tab → ' + (action.url || ''),
    switch_tab:     () => 'Switch tab → ' + (action.host || action.title || ''),
    close_tab:      () => 'Close tab ' + (action.host || ''),
    bookmark_add:   () => 'Bookmark "' + (action.title || action.url || 'current page') + '"',
    bookmark_search:() => 'Search bookmarks "' + (action.query || '') + '"',
    save_page:      () => 'Save page as MHTML archive',
    screenshot_save:() => 'Save screenshot "' + (action.label || '') + '"',
    organize_tabs:  () => 'Organize tabs (' + (action.mode || 'group') + ')',
    read_later_add: () => 'Add "' + (action.title || action.url || 'page') + '" to reading list',
    read_later_list:() => 'Show reading list',
    monitor_start:  () => 'Monitor page every ' + (action.intervalMin || 15) + ' min' + (action.checkText ? ` for "${action.checkText}"` : ''),
    use_skill:      () => 'Activate skill "' + (action.id || action.skill || '') + '"',
    list_tabs:      () => 'List open tabs',
    ask_website:    () => 'Search this page for "' + String(action.query || '').substring(0, 50) + '"',
    highlight_element: () => 'Highlight section ' + (action.id || ''),
    find_history:   () => 'Search history for "' + String(action.query || '').substring(0, 50) + '"',
    done:           () => 'Done',
  };
  return (map[action.type] ?? (() => action.type))();
}
