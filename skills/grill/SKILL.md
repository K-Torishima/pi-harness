---
name: grill
description: Grill the user one question at a time to surface gaps and contradictions. Works for designs before implementation, changes after implementation, and decisions outside software. Use when the user says "/skill:grill", "grill me", or asks to be questioned hard.
disable-model-invocation: true
---

# grill

Bring the decisions that live in the user's head out into the open by asking about them one question at a time. The goal is to get the user and you to the same understanding, not to produce an answer first. While grilling, do not change any code or documents.

## 1. Pick the mode

Decide from what you were given. If you cannot tell, make that your first question.

- **Design**: a plan, spec, or idea for something not built yet
- **Review**: a change that already exists (`git diff`, a branch, or a PR number)
- **Decision**: something outside software (a project, money, how to spend time, how to deal with someone)

## 2. Look things up yourself first

If the answer is in the code, the docs, or the git history, read it instead of asking.

- **Design**: read AGENTS.md, CLAUDE.md, the README, and the relevant code, plus `CONTEXT.md` and `docs/adr/` if they exist
- **Review**: get the diff and read around the changes, the callers, and the tests. If the diff is empty, say so and stop
- **Decision**: work only from what you were given; do not go off researching on your own

## 3. Build the question tree

List what needs deciding as branches, ordered so that what other branches depend on comes first. Do not show this tree to the user.

Branches to always cover:

- **Design**: what is in and out of scope, what happens on failure, boundary values, state transitions, compatibility with what already exists
- **Review**: failure paths, cleanup, secrets, concurrent use, whether the tests would notice a breakage
- **Decision**: the real goal, the cost of not doing it, the worst case, when to stop

In a review, do not turn a bug you can confirm by reading the code into a question. List it under "must fix" at the end instead.

## 4. Ask one question at a time

Ask exactly one question per reply. Then stop and wait for the answer.

Always use the same shape:

```
Q<number>. <the question, one sentence>
A. <recommended option> (recommended): <reason, one sentence>
B. <another option>: <when this one is better, one sentence>
C. <another option>: <when this one is better, one sentence>
```

- Make it answerable with a single letter. Offer 2 or 3 options
- Always put the recommendation at A, with a reason
- For questions that are not a choice (a number, a name), put your best guess at A and add "write it in if this is wrong"
- If a tool that presents options (such as `question`) is available, ask with it instead of writing the options out
- If an answer contradicts the code or an earlier answer, point to where, and make "which one is right" the next question
- When a vague word comes up, offer precise alternatives as the options

## 5. Finish

When the main branches are all decided, or the user says to stop, stop grilling and wrap up in this shape:

- **Decided**: one item per line
- **Still open**: who decides what
- **Must fix** (review only): `file:line` and what would count as fixed
- **Verdict** (review only): "ready to merge", "fix first", or "not enough information"

Ask one last question: whether to record the outcome in docs (terms in `CONTEXT.md`, decisions in `docs/adr/`). Do not start implementing until the user asks for it separately.

Reply in the language the user writes in.
