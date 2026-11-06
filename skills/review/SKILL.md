---
name: review
description: Review a change for bugs, for whether it does what was intended, and for review comments still open on its PR. Use before opening or merging a PR, when the user says "/skill:review", "review this", "レビューして", or gives a PR number to check. Reports findings; does not edit unless asked to fix.
---

# review

Find what is actually wrong with a change, and only that. A short list of real problems beats a long list of maybes.
Do not edit files, post comments, or push while reviewing. If the request says to fix, finish the review first, then fix, then review the fixes again.

## 1. Pin down the change

- A PR number: `gh pr view <n> --json title,body,baseRefName,headRefName,files` and `gh pr diff <n>`
- A branch or path: the diff of that branch against the default branch, or of that path
- Nothing given: uncommitted changes (`git diff HEAD`, plus untracked files). If there are none, the current branch against the default branch (`git diff $(git merge-base HEAD origin/HEAD)...HEAD`)

If the diff is empty, say so in one line and stop.

## 2. Find out what it was meant to do

Read, in this order, whatever exists: the PR body and the issue it links, the commit messages, then the repo's rules (`AGENTS.md`, `CLAUDE.md`, and docs the change touches).
Write the intent down for yourself in one sentence. Without it, you can only find typos.

## 3. Collect open review comments (PRs only)

Earlier reviews, including bots such as Codex, often leave inline comments that are easy to miss:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved path line comments(first:5){nodes{author{login} body}}}}}}}' -F o=<owner> -F r=<repo> -F n=<n>
```

Keep the threads with `isResolved: false`. Check each one against the current code: already fixed, still a problem, or wrong.

## 4. Read the change against three questions

Read around each hunk: the callers, the tests, and the code it replaced. Not just the `+` lines.

1. **Does it break?** A concrete input or state that gives a wrong result, a crash, or lost data. Failure paths, empty and boundary values, concurrent use, cleanup.
2. **Does it do what was intended?** Compare with the one-sentence intent and the repo's rules. Missing parts, extra parts nobody asked for, a design that contradicts a decision written down.
3. **Would the tests notice?** If you broke the new behavior, would a test fail? Name the case that is not covered.

Security (secrets, injection, access checks, permissions) is `/skill:security`'s job; the PR gate runs it too.

## 5. Verify every finding before you keep it

For each candidate, follow the code path that would fail. Run a quick check when it is cheap (a one-line script, an existing test, a grep for callers).
- Confirmed: keep it
- Plausible but not confirmed: keep it only if the harm would be serious, and mark it "unverified"
- Style or taste: drop it. That belongs to `/skill:simplify`

## 6. Report

Start with the verdict line exactly as below, label in English even when you reply in another language (the PR gate looks for `Verdict:`). Then the findings, most severe first, one or two lines each:

```
Verdict: fix first | ready to merge | not enough information
1. path/to/file.ts:42 — <what is wrong>. Breaks when <concrete input or state>.
2. ...
Open review comments: <n> still apply — <file:line, one line each>; <m> already fixed or wrong.
```

If nothing survived verification, say "Nothing to fix" and the one riskiest spot you checked.
Reply in the language the user writes in.
