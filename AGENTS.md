# AGENTS.md

A personal harness for pi (earendil-works/pi-coding-agent). It is loaded as a local pi package from `packages` in `~/.pi/agent/settings.json`.

## Layout

- `extensions/<name>/index.ts` is one extension. pi loads it directly with jiti, so there is no build step
- `skills/<name>/SKILL.md` is one skill, invoked with `/skill:<name>`
- `themes/*.json` are themes
- `agent/` holds files that are linked into `~/.pi/agent/` with `make link` (currently `APPEND_SYSTEM.md`)
- Only `extensions/voice/helper/main.swift` is built, with `make` (`bin/` is not committed)
- `extensions/lib/` holds code shared between extensions (such as reading shell commands). It has no `index.ts`, so pi does not load it as an extension. Never put a `.ts` file directly in `extensions/`: pi loads those as extensions
- Tests sit next to the code as `*.test.ts` and run with `make test`. `test/` holds shared test helpers (loading an extension through pi's own loader, fake secrets); build fake secrets at run time so no file looks like it holds a real one
- Personal guard rules go in `extensions/guard/rules.local.json`, which is gitignored. Never commit personal paths, names, or secrets

## How this harness grows

- pi is used as a single-user coding agent. Parallel development (worktrees side by side in split terminals) lives outside pi, in a terminal app, and is not built into this harness
- Long runs are split into "the loop" and "keeping it alive". The loop — set done criteria, verify, fix, repeat (goal, loop) — needs the conversation context, so it lives in this harness. Keeping a process alive while it is left alone for hours lives outside pi (on a separate machine, for example)
- The everyday model is Codex (a ChatGPT subscription). Using a Claude subscription through pi is billed per use

- Do not port the Claude Code harness (`~/.claude` hooks, skills, agents) wholesale. Its current shape is not necessarily good
- While using pi, add only what was actually missed, one named extension at a time
- Do not copy when adding. Ask whether it really helped, and rebuild it in a shape that fits pi
- Decide what to add from records, not hunches. Look back over pi's session logs (`~/.pi/agent/sessions/`); when an instruction or a redo keeps coming back, stop asking for it in words and promote it to a rule, an extension, or guard. Prevention that keeps drift from happening (such as anchor) and diagnosis that finds drift afterwards go together

## How to work here

- For the pi extension API, read `docs/`, `examples/extensions/`, and `dist/**/*.d.ts` under `$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent/`
- After a change, run `/reload` inside pi or restart pi to check it
- The voice helper can be tried without a microphone with `--file <audio file>`
- Voice input and read-aloud mirror the Alora app. When fixing them, look at the same logic in Alora too
- Write code, comments, docs, UI text, and commit messages in English

## This repository is public

- Never commit personal email addresses, absolute paths under a home directory, names of private repositories or folders, keys, tokens, or `.env` files
- Commit messages follow Conventional Commits and do not include session URLs or other identifiers
- Before committing, read the staged diff (`git diff --cached`) and check it for the items above
