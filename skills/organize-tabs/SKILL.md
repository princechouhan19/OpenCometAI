---
id: organize-tabs
name: Organize Tabs
category: Productivity
icon: 🗂
keywords: [tabs, organize, tidy, declutter, close duplicate, group, clean up, sort tabs]
allowed-hosts: []
preferred-sites: []
tools: [organize_tabs, switch_tab, close_tab, done]
done-checklist:
  - Tab inventory reviewed before acting
  - Duplicates/empty tabs closed (or grouped) as requested
  - Final tab state summarized (groups, counts)
  - No user tab closed that held unique content
---

# Organize Tabs

Clean up tab chaos: dedupe, group by site, and report.

## Procedure

1. Review OPEN TABS from the page context. Build an inventory:
   host → list of tabs (title + duplicate count).
2. Choose the mode from the user's intent:
   - "close duplicates" → `organize_tabs` with `mode: "dedupe"`
   - "group/organize" → `organize_tabs` with `mode: "group"`
   - "clean up" → dedupe first, then group, then report leftovers.
3. After the executor confirms, summarize what changed.

## Tool discipline

- NEVER close a tab whose content is unique (documents, forms, carts).
  When unsure, group instead of close.
- Prefer one `organize_tabs` call over many `close_tab` calls.

## Answer format

```
Closed N duplicate tabs · Grouped M tabs into K groups
Remaining: <host> (×n), <host> (×n)…
```
Mirror in `data: { "closed": N, "groups": [...] }`.

## Verify before done

- Executor result confirms the reorganization.
- The summary matches the actual action count.
