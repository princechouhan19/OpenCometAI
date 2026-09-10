---
id: monitor-page
name: Monitor Page
category: Productivity
icon: 👁
keywords: [monitor, watch, track, notify, alert, price drop, restock, back in stock, check periodically, keep an eye]
allowed-hosts: []
preferred-sites: []
tools: [monitor_start, extract, done]
done-checklist:
  - Monitor registered with URL + interval + what-to-watch
  - Confirmation includes when the first check will run
  - User told how the alert will arrive (notification)
---

# Monitor Page

Register a background watcher that re-checks a page and notifies on change.

## Procedure

1. Determine WHAT to watch: a price, a text string ("In stock"), a section
   of the page, or the page overall. Get the interval if the user said one,
   else default to every 15 minutes.
2. Ensure the current tab is on the target URL (navigate first if needed),
   then call `monitor_start` with:
   - `url` — the page to watch
   - `intervalMin` — minutes between checks
   - `checkText` — optional exact text/selector value to detect
3. Confirm registration from the executor result. State the schedule and
   that a desktop notification will fire on change.

## Tool discipline

- One monitor per URL — re-registering the same URL updates the previous one.
- Prefer a narrow `checkText` (e.g. "₹4,999", "Out of stock") over whole-page
  diffs — fewer false alarms.
- Monitoring runs locally in the extension; no page content leaves the device
  unless Privacy Mode is off.

## Answer format

`👁 Watching <url> every <N> min for <what>. You'll get a notification when it changes.`
Mirror in `data: { "monitor": { url, intervalMin, checkText } }`.

## Verify before done

- Executor returned `{ ok: true, monitor }` — never claim a monitor exists
  without that confirmation.
