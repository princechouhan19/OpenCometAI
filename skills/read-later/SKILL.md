---
id: read-later
name: Read Later
category: Productivity
icon: 📚
keywords: [read later, reading list, save for later, save article, queue, reading queue]
allowed-hosts: []
preferred-sites: []
tools: [read_later_add, read_later_list, extract, done]
done-checklist:
  - Article(s) added to the reading list with title + URL
  - List request returned every saved item
  - No duplicates created for the same URL
---

# Read Later

Queue articles for later reading, and recall the queue on demand.

## Procedure

1. "Save this/read later" → `read_later_add` for the current page (or the
   URLs the user listed). The executor stores title, URL, and added-at time.
2. "What's on my reading list / show my queue" → `read_later_list`, then
   present items oldest-first (or newest-first if the user prefers).
3. Optionally add a one-line note per item from the page's own description.

## Tool discipline

- Check the list before adding: if the URL is already queued, say so and skip.
- Never auto-add more than the user asked for.
- Works fully offline in extension storage (and mirrors to the browser's
  reading list where available).

## Answer format

`📚 Added "Title" — 3 items in your queue now.`
For list requests, a compact numbered list with titles + hosts.
Mirror in `data: { "readingList": [...] }`.

## Verify before done

- Executor confirmed each add ({ ok: true }).
- Reported queue count matches the executor's list length.
