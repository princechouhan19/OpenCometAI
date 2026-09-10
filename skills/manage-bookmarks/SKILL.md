---
id: manage-bookmarks
name: Manage Bookmarks
category: Productivity
icon: 🔖
keywords: [bookmark, bookmarks, save link, favorites, favourite, organise bookmarks, find bookmark, delete bookmark]
allowed-hosts: []
preferred-sites: []
tools: [bookmark_search, bookmark_add, new_tab, done]
done-checklist:
  - Requested bookmark operation performed and confirmed
  - Search/list results accurate (title + URL shown)
  - No bookmarks modified beyond what the user asked
---

# Manage Bookmarks

Read, search, and organize the user's Chrome bookmarks through native APIs.

## Procedure

1. "Find/search my bookmarks" → `bookmark_search` with the query.
   Present matches as title + URL + folder, most relevant first.
2. "Bookmark this page" → `bookmark_add` (defaults to the current tab).
   Confirm with the created bookmark's title and URL.
3. For bulk organization requests, list what you found FIRST, propose the
   change, and only then apply it. Never mass-delete.

## Tool discipline

- `bookmark_search` before any add — avoid duplicates: if the URL already
  exists, report that instead of creating a second entry.
- Create bookmark folders only when the user asked for organization.

## Answer format

Short confirmation lines: `✚ Added "Title" → folder` or a list of matches.
Mirror results in `data: { "bookmarks": [...] }` when listing.

## Verify before done

- The action result (executor output) confirms the bookmark operation.
- Nothing was changed that the user did not request.
