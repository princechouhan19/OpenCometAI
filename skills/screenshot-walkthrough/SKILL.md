---
id: screenshot-walkthrough
name: Screenshot Walkthrough
category: Research
icon: 📸
keywords: [screenshot, screenshots, walkthrough, step by step, how to, show me steps, visual guide, tutorial]
allowed-hosts: []
preferred-sites: []
tools: [screenshot_save, click, navigate, type, done]
done-checklist:
  - Every major step captured as a saved screenshot
  - Steps numbered with the exact action taken
  - Screenshots saved to Downloads (filenames reported)
---

# Screenshot Walkthrough

Produce a visual step-by-step guide by DOING the flow and capturing each step.

## Procedure

1. Break the requested flow into its natural steps (e.g. "open settings →
   click Export → choose CSV"). Max 8 steps.
2. For each step: perform the action (`click`/`type`/`navigate`), let the
   page settle, then `screenshot_save` with `label: "step-<n>-<slug>"`.
3. Note the exact element label you acted on and what changed afterwards.
4. Finish with the complete numbered guide.

## Tool discipline

- One screenshot after each meaningful state change — not after every click.
- If a step fails, capture the failure state too; it is useful documentation.
- Do not submit/purchase/irreversible-commit anything while walking through.

## Answer format

```
Step 1 — <action> : <what happened> (📸 step-1-...png)
Step 2 — ...
Files: N screenshots in Downloads.
```

## Verify before done

- Each step maps to a confirmed executor save result.
- The action sequence is reproducible from the guide alone.
