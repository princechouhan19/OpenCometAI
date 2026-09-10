---
id: compare-prices
name: Compare Prices
category: Shopping
icon: 🛒
keywords: [price, prices, cost, cheapest, lowest, deal, discount, buy, shopping, compare, amazon, flipkart, offer]
allowed-hosts: []
preferred-sites: [amazon.in, flipkart.com]
tools: [search, new_tab, switch_tab, extract, done]
done-checklist:
  - Product found on at least 2 shopping sites
  - Name, price, rating, URL captured per site
  - Best deal explicitly identified with total cost
  - Comparison table returned in `data`
---

# Compare Prices

Cross-store price comparison with an explicit verdict.

## Procedure

1. Determine the exact product identity from the task (model, size, variant).
   If ambiguous, pick the most common variant and say so in the answer.
2. `search` the product + "buy" on the first preferred site, open the best
   product link with `new_tab`.
3. On each product page `extract`: title, current price (with currency),
   rating, review count, delivery cost/eta if shown, and the canonical URL.
4. Repeat for at least one more site (`switch_tab` between them, max 4 tabs).
5. Return `done` with a comparison table and the winner.

## Tool discipline

- Open real product pages — do not price from search-result snippets.
- If a site fails/blocks, note it and continue with the others; never stall.
- Prefer `preferred-sites` first, then any relevant store from the task text.

## Answer format

```
| Store | Product | Price | Rating | URL |
Winner: <store> at <price> (<savings vs next best>)
```
Also mirror the rows in `data: { "comparisons": [...], "best": {...} }`.

## Verify before done

- Prices are read from the product page itself, not memory or snippets.
- At least 2 stores compared.
