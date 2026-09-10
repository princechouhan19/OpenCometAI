---
id: find-alternatives
name: Find Alternatives
category: Research
icon: 🔁
keywords: [alternative, alternatives, instead of, similar, replacement, substitute, competitor, other options, open source alternative]
allowed-hosts: []
preferred-sites: []
tools: [search, new_tab, extract, done]
done-checklist:
  - 3–5 distinct alternatives found and verified
  - One-line profile per alternative (what/why/price model/URL)
  - A clear recommendation matched to the user's context
---

# Find Alternatives

Discover and vet replacement options for a product, tool, or site.

## Procedure

1. Capture the baseline: what the user has now, and WHY they want out
   (price, features, platform, privacy). The "why" drives selection.
2. `search` "<name> alternative" AND "<name> open source" (or the
   dimension that matters). Open 2–3 promising results with `new_tab`.
3. For each candidate verify on its own page: what it is, platform,
   pricing model, the killer differentiator, URL. Discard dead/megated projects.
4. Pick 3–5 finalists that genuinely differ from each other.

## Tool discipline

- Aggregate lists (e.g. "top alternatives" articles) are LEADS, not answers —
  always confirm on the candidate's own site.
- Skip sponsors/ads in results; prefer independent mentions.

## Answer format

```
1. <Name> — <one-line what> · <pricing> · why it fits: <reason> (<url>)
...
**Recommendation:** <one, matched to the user's stated reason>
```
Mirror the list in `data: { "alternatives": [...] }`.

## Verify before done

- Each alternative was confirmed on its own page (not just a listicle claim).
- Recommendation addresses the user's actual motivation.
