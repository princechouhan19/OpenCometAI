---
id: fill-form
name: Fill Form
category: Form Filling
icon: 📝
keywords: [fill, form, apply, application, register, signup, sign up, checkout, autofill, questionnaire]
allowed-hosts: []
preferred-sites: []
tools: [type, click, submit, key, done]
done-checklist:
  - Every visible required field identified and filled
  - Values sourced from USER PROFILE / task text only
  - Nothing submitted unless the user explicitly asked
  - Confirmation state described in the answer
---

# Fill Form

Safe form completion. Fill everything you can, submit nothing without permission.

## Procedure

1. Inventory every field from `AVAILABLE INPUTS` and INTERACTIVE ELEMENTS:
   inputs, textareas, selects, checkboxes, radios. Note label/placeholder/name.
2. Map each field to a value from (in order): explicit task text →
   USER PROFILE → sensible neutral placeholder. NEVER invent legal,
   payment, or identity data that was not provided.
3. `type` into each field. For selects use `click` then pick the option
   element. For checkbox consent: tick only what is required to proceed.
4. Fill EVERYTHING first, then stop and report. `submit` ONLY if the task
   explicitly says to submit/send/apply.

## Tool discipline

- One field per `type` action; verify the value stuck from the page diff.
- If a validation error appears, fix THAT field using the error text —
  do not re-fill the whole form.
- Never touch fields the task did not mention if they are optional and unclear.

## Answer format

List: field → value filled (mask sensitive values like passwords as •••).
State clearly whether the form was submitted or left ready for review.

## Verify before done

- Required fields show no validation errors in the latest page state.
- Submission happened only with explicit user instruction.
