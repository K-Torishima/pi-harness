---
name: polish
description: Simplify a change and then review it, in one go - first make it smaller and plainer without changing what it does, then review the result for bugs and for whether it does what was intended. Use before opening a PR, or when the user says "/skill:polish" or asks for simplify and review together. Edits only for the simplify part; the review part reports.
---

# polish

Two skills in a row, on the same change. Simplify first, so the review reads the code that will ship.
Both live in the skills folder next to this one: `../simplify/SKILL.md` and `../review/SKILL.md`, relative to this file.
Read each one with the read tool when its step starts, and follow it as written. Do not work from memory of them.

## 1. Simplify

Read `../simplify/SKILL.md` and follow it on the change: pick the change (a PR number, branch, or path given to this skill, else the default), make the edits, and run the tests.
If a bug turns up, do not fix it here; carry it into the review.

## 2. Review

Read `../review/SKILL.md` and follow it on the same change, now including the simplify edits.
Add any bug noted during simplify to the candidates, and verify it like the others.

## 3. Report

One reply, review first, because it decides what happens next:

```
Verdict: fix first | ready to merge | not enough information
1. path/to/file.ts:42 — <what is wrong>. Breaks when <concrete input or state>.
Simplified: <n> edits, tests pass
- path/to/file.ts — <what got simpler>
```

Keep the `Verdict:` label in English even when you reply in another language (the PR gate looks for it). Reply in the language the user writes in.
A PR still needs `/skill:security` after the last change.
