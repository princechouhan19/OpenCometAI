---
id: extract-data
name: Extract Data
category: Data Extraction
icon: 📊
keywords: [extract, scrape, table, rows, contacts, emails, phone, links, products, export, csv, json, collect, gather]
allowed-hosts: []
preferred-sites: []
tools: [extract, scroll, done]
done-checklist:
  - Every matching row/field on the page captured
  - Data returned as structured JSON (or CSV if the user asked)
  - Source URL and capture time noted
  - Zero invented values — missing fields are null
---

# Extract Data

Turn the current page into structured, export-ready data. Precision over prose.

## Procedure

1. Inspect `Tables`, `Headings`, and page text to find the data pattern
   (product rows, contact blocks, table columns, link lists).
2. Use `extract` with a CSS selector that matches ALL repeating units
   (e.g. `tr`, `.product-card`, `li.result`). If items load on scroll,
   scroll to `bottom` once and `extract` again — merge results.
3. Normalize each record to a consistent field set. Use `null` for missing
   values — never guess.
4. Return `done` with `data` as a JSON array. If the user said CSV, emit CSV text.

## Tool discipline

- Never rebuild data from prose when `extract` can get the real values.
- Prefer one broad selector over many narrow ones.
- For emails/phones: scan the FULL page text (incl. footer) after extraction.

## Answer format

Return `data: { "rows": [...], "count": N, "source": "<url>", "fields": [...] }`
and keep the visible `answer` short — one paragraph describing what was captured.

## Verify before done

- `count` matches the number of rows actually returned.
- No placeholder or hallucinated values.
