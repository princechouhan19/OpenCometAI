---
id: save-page
name: Save Page
category: Productivity
icon: 💾
keywords: [save page, archive, mhtml, download, offline, keep a copy, save as file, snapshot]
allowed-hosts: []
preferred-sites: []
tools: [save_page, screenshot_save, done]
done-checklist:
  - Page archived via native save (MHTML) or screenshot
  - Downloaded filename reported to the user
  - Save confirmed from executor result, not assumed
---

# Save Page

Archive the current page as a real file the user can keep offline.

## Procedure

1. Default to full-page archive: call `save_page` (MHTML). It captures the
   current tab exactly as rendered, downloads go to the user's Downloads
   folder, and the executor returns the saved filename.
2. If the user asked for a picture (or the page is a canvas/map/visualization),
   use `screenshot_save` with a short `label` instead.
3. Report exactly where the file went and what it contains.

## Tool discipline

- One save per request — do not produce both formats unless asked.
- If the save fails (e.g. chrome:// pages cannot be captured), explain why
  and suggest a screenshot as fallback.
- Never re-navigate before saving — save the page in its current state.

## Answer format

`💾 Saved "<title>" as <filename> (MHTML archive, Downloads folder).`
Mirror in `data: { "file": filename }`.

## Verify before done

- Executor returned `{ ok: true, filename }` — never claim a save happened
  without that confirmation.
