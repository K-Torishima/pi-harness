---
name: simplify
description: Make a change smaller and plainer without changing what it does - reuse existing helpers, remove duplication, dead code, needless layers, and wasted work - then run the tests. Use before review and before opening a PR, or when the user says "/skill:simplify", "シンプルにして", or "simplify this".
---

# simplify

Leave the change doing exactly what it did, with less code and fewer ideas to hold in your head.
This is not a bug hunt (that is `/skill:review`) and not a redesign. If you find a bug, note it and leave it for the review.

## 1. Pin down the change

Same as review: a PR number, a branch, a path, or by default the uncommitted changes, else the current branch against the default branch. Only simplify code this change added or touched.

## 2. Look for these, in this order

1. **Something that already exists.** Search the repo for a helper, type, or pattern that does the same job (`rg` for the key names and verbs). Prefer reusing it over a new copy
2. **Duplication inside the change.** The same few lines twice, or two functions that differ by one value
3. **Layers that do nothing.** A wrapper that only forwards, an option nobody passes, a type used once, a config for a value that never changes
4. **Dead or defensive code.** Unused imports, parameters, and branches; checks for cases the caller already rules out; try/catch that only rethrows
5. **Wasted work.** The same file read or the same command run twice, work inside a loop that could happen once
6. **Comments that repeat the code.** Keep comments that say why; drop ones that say what the next line does

## 3. Change it

- Keep behavior identical: the same outputs, errors, and side effects. Do not change public names or formats unless the change itself introduced them
- Follow the repo's existing style, even where you would write it differently
- Make each edit small and separate, so one can be undone without the others

## 4. Prove nothing changed

Run the repo's tests, type check, and lint (look in `Makefile`, `package.json`, or the README for how). If something fails because of your edit, undo that edit rather than working around it.

## 5. Report

Keep it to a few lines:

```
Simplified: <n> edits, tests pass
- path/to/file.ts — <what got simpler, one line>
Left as is: <one thing you considered and why it stays>
```

If nothing was worth changing, write `Simplified: 0 edits (already simple)` and stop.
Keep the `Simplified:` label in English even when you reply in another language (the PR gate looks for it). Reply in the language the user writes in.
