# DOM detector: element tagging and relocation

How the extension finds every interactive control on a page, labels it on
screen, and clicks the exact element the model chose.

## What it does

`src/content/dom-detector.js` walks the whole page and identifies interactive
elements the way a user sees them: anything that responds to a cursor, a tap or
keyboard focus. Each one is painted with a box and a numeric badge.

The number is the identity that ties three things together:

- The screenshot shows badge `15` next to a button.
- The interactive element list in the prompt contains the same control as
  `uid:nx-15`.
- The model answers `{"selector": "uid:nx-15"}`, and the executor relocates
  that element.

One identity per control across screenshot, prompt and click, with no
coordinate guessing.

## Detection pipeline

```mermaid
flowchart TD
  INJECT["sw.js: runDomDetector<br/>inject if missing, then scan"] --> TRAV["Traverse the live DOM<br/>main document first"]
  TRAV --> SHADOW["Descend into shadow roots<br/>and same-origin iframes<br/>(iframe bounds = cumulative offsets)"]
  SHADOW --> CAND["Collect interactive candidates"]
  CAND --> CURSOR{"Computed cursor style<br/>pointer / text?"}
  CURSOR -->|yes| OK["Interactive"]
  CURSOR -->|no| ROLE{"tag / role / contenteditable<br/>/ event attributes?"}
  ROLE -->|yes| OK
  ROLE -->|no| DROP1["Skip: decoration"]
  OK --> TOP{"elementFromPoint guard<br/>centre + corners"}
  TOP -->|"covered by modal / sticky bar"| DROP2["Drop: not reachable"]
  TOP -->|"visible"| DEDUP{"Distinct-interaction rule"}
  DEDUP -->|"nested inside a parent control"| PARENT["Collapse into parent"]
  DEDUP -->|"acts on its own"| ASSIGN["Assign uid nx-N<br/>+ paint box + numeric badge"]
  PARENT --> ASSIGN
  ASSIGN --> OUT["Emit element items<br/>uid, role, tag, text, bounds, xpath"]
  OUT --> REG["Live registry<br/>uid to element (survives SPA re-renders)"]
  OUT --> PROMPT["sw.js getPageInfo<br/>interactive element list"]
  PROMPT --> SHOT["Screenshot with overlay painted<br/>badges visible to the model"]
```

Three decisions carry most of the result:

- **Cursor first.** The computed `cursor` style is the strongest single signal,
  checked before tag, role, contenteditable and event-attribute heuristics.
  Custom widgets register even though they are not native controls: video
  player controls, mail chips, cards built as plain `<div>`s.
- **Top-element guard.** `elementFromPoint` at the centre and corners drops
  controls buried under modal backdrops, sticky headers and consent bars. ARIA
  menu containers stay exempt, because their options legitimately render over
  other content.
- **Distinct-interaction rule.** Nested interactives collapse into their parent
  unless they act on their own, so a composite widget gets one badge rather than
  a cluster.

## From badge to click

Pages re-render between the scan and the click. The detector gives the executor
four independent ways back to the same element:

```mermaid
flowchart TD
  ACT["actions.js domClick / domType / scroll_to_uid<br/>selector = uid:nx-N"] --> R1{"1. Live registry lookup<br/>window.__openCometElRegistry"}
  R1 -->|"hit"| EXEC["Resolve and act"]
  R1 -->|"miss (page re-rendered)"| R2{"2. uid attribute lookup<br/>main document + accessible iframes"}
  R2 -->|"hit"| EXEC
  R2 -->|"miss"| R3{"3. Detector-recorded xpath"}
  R3 -->|"hit"| EXEC
  R3 -->|"miss"| R4["4. Legacy fallbacks<br/>ordinal / ref name / text / bounds"]
  R4 --> EXEC
  EXEC --> RCPT["Receipt in the result<br/>resolution path + element identity"]
```

The registry is the strongest link: a live `Map` of uid to element survives SPA
re-renders and reaches into shadow roots and iframes that `querySelector` cannot
cross. Xpath is the deterministic fallback. Text, ordinal and bounds matching
remain as the last resort, so nothing the old scan could click becomes
unclickable.

## What the model sees

Three views of the same page are fused into one prompt:

| View | Source | Carries |
|---|---|---|
| Screenshot | `chrome.tabs.captureVisibleTab`, with the badge overlay painted | Boxes and numeric badges |
| Element list | `dom-detector.js` items via `sw.js getPageInfo` | `uid:nx-N`, role, text, bounds, xpath |
| Page text | Inline scan, unchanged | Headings, tables, form labels |

The prompt states the mapping explicitly (`src/lib/prompts.js`): screenshot
badge `15` is selector `uid:nx-15`. The model is told to prefer `uid:`
selectors and fall back to `text:` or CSS only when the list has no match.

## Element fields

| Field | Meaning |
|---|---|
| `uid` | Stable id `nx-N`; the badge number is the uid without the prefix, also stamped as a DOM attribute |
| `role`, `tag` | Accessibility role or tag name |
| `text` | Visible label, truncated |
| `bounds` | Page-space rectangle; iframe items arrive pre-translated by cumulative offsets |
| `xpath` | Detector-recorded path, the deterministic relocation key |
| `editable`, `href` | Type hints that route items into the input and link groups |

Cross-origin frames are out of scope: they carry an error marker and are
skipped. Pixel-level privacy scanning still covers their contents.

## Where it hooks in

- `sw.js`: `runDomDetector()` (inject if missing, then scan), detector-first
  `getPageInfo` with the legacy inline scan as fallback, screenshot overlay
  coordination.
- `src/background/actions.js`: `domClick`, `domType` and `scroll_to_uid`
  relocation, plus disambiguation receipts.
- `src/content/dom-detector.js`: detection, painting, registry.
- `src/lib/prompts.js`: the badge-to-uid contract.
