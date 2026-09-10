---
id: summarize-page
name: Summarize Page
category: Research
icon: 📄
keywords: [summarize, summarise, summary, tldr, key points, overview, brief, digest, explain]
allowed-hosts: []
preferred-sites: []
tools: [extract, scroll, done]
done-checklist:
  - Main topic identified from page content
  - Key points listed as concise bullets
  - Summary stays under 300 words
  - No navigation performed unless page content was empty
---

# Summarize Page

Summarize the page the user is already on. Text-first, zero-navigation by default.

## Procedure

1. Read `Readable page text` and `Headings` from the structured page data FIRST.
   Do not take a screenshot-driven approach unless text is empty or navigation is required.
2. If the content is longer than the visible excerpt, use ONE `scroll` to `bottom`,
   then one `extract` on the main content container if more detail is needed.
3. Identify: main topic, 3–7 key facts or arguments, data points, and the conclusion or call-to-action.
4. Return `done` with a structured answer.

## Tool discipline

- NEVER navigate away from the page for a plain summary — everything needed is on the page.
- Prefer `extract` over repeated scrolling. One scroll to bottom is the maximum.
- If the page is a paywall/login wall with no readable text, say so in the answer and stop.

## Answer format

```
**Topic:** one line
**Key points:** 3–7 bullets, each one line
**Details worth noting:** numbers, dates, names (only if present)
**Bottom line:** one sentence
```

## Verify before done

- The answer cites facts that actually appear in the page text — never invent content.
- Under 300 words.
