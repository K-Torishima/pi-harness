# pi-harness

A personal harness for the [pi](https://pi.dev) coding agent, loaded as a local pi package.
It is grown one piece at a time: only things that were actually missed while using pi get added.

## What's inside

### Look and feel

- `extensions/zenkai-code/` — the "ZENKAI CODE" look: a logo that flares up at startup, plus an editor and footer in Hermes Agent's gold and bronze palette. `/zenkai-code` toggles back to pi's default look
- `extensions/quiet-tools/` — folds the output of read, bash, grep, find, and ls into a single "→ 42 lines" line. Failures and anything you expand with Ctrl+O are shown in full
- `themes/zenkai.json` — readable body colors with a fire-orange accent

### Staying on track

- `extensions/anchor/` — pins the current focus, the next step, and what was decided, rejected, and left open, so neither you nor the AI drifts
  - Shows "◎ focus" and "▸ next" above the editor, and sets the terminal tab title to the focus
  - Before every model call (not just every request), the AI re-reads the focus, what is decided, rejected, and still open, and the rules. It is never stored, so long runs and compaction do not wash it out
  - When your message looks like it decides or rejects something, the AI is asked to record it
  - `/focus <focus>`, `/decided <decision>`, `/rejected <option>`, `/now`, `/anchor clear`. A goal set with `/goal` becomes the focus
- `extensions/goal/` — `/goal <goal>` makes the AI define done criteria and keep working until they hold
  - Stops when the AI reports done or blocked through the goal tool, or on Esc, an error, or after 15 rounds. `/goal` shows the state, `/goal stop` gives up
- `extensions/reply/` — makes the final reply fit its reader, and says when a long run is done
  - Before pi settles, the reply is sent back once to be rewritten when it is English to a Japanese writer, over 600 characters or 15 lines without a request for detail, mentions `#123` with no title or link, asks "A or B?" without spelling the options out, or opens with a preamble. The first version is dropped from the AI's context
  - Runs of 30 seconds or more end with a macOS notification showing the first line of the reply. `/reply` shows the rules
- `extensions/evidence/` — a reply may only claim what was checked, and only ask what could not be looked up
  - Keeps a tally per request of what the AI looked up, changed, and verified (tests, builds, type checks, linters, running the thing)
  - The final reply is sent back once when it says tests pass with no run after the last change, says something works with neither a run nor a look after the last change, or asks you for a fact (where, which, the URL) without having looked anything up. `/evidence` shows the tally
- `extensions/lens/` — draws one lens card per session (doubt yourself, a better plan, laziness, impatience, hubris, …) and shows it below the editor
  - The AI gets the same card and adds one "Lens:" line to its reply only when it truly applies
  - `/lens` draws again, `/lens add <name>: <question>` adds a card, `/lens list` shows the deck. The deck is `lenses.json`
- `skills/grill/` — grills you one question at a time to align understanding, for designs, reviews, and decisions alike. Run with `/skill:grill`
- `agent/APPEND_SYSTEM.md` — added to pi's system prompt: short replies that lead with the conclusion, picking up lenses, and doubting its own plans. `make link` links it into `~/.pi/agent/`

### Safety

- `extensions/guard/` — blocks only what the AI must never do. Rules live in `rules.json`
  - Blocks `sudo`, `rm -rf`, reading `.env` and credential files, commands that print secrets (`get-secret-value`, `gh auth token`, `printenv`, …), force pushes, and git commands that throw away work
  - Personal rules go in `rules.local.json` (gitignored) and are merged in
  - Commands you type yourself with `!` are never blocked. `/guard` lists the rules
- `extensions/mandate/` — lets the AI act only on what you asked for, and stops it asking about what you already allowed
  - Each message you type starts in `look` (read and answer). The AI moves to `do` by quoting your words; a quote that is not in your latest message is rejected
  - In `look` and `plan`, edits and changing commands are blocked. Outward actions (`git push`, PR and issue writes, deploys, API writes) need a grant, which lasts for the session
  - In `do`, a reply that ends by asking permission to go on is sent back once to carry on. `/goal` switches to `do`
  - `/mode look|plan|do`, `/allow push|pr|issue|deploy|api`, `/revoke <grant>|all`, `/mandate`
- `extensions/secrets/` — keeps secrets out of the AI's context and out of what leaves the machine
  - Tokens, keys, and private keys in tool output are replaced with `[redacted <kind>]` before the AI sees them
  - Before `git commit`, `git push`, and `gh pr create`, the added lines are scanned for secrets, `.env` and key files, paths under your home directory, and your git email. A `password = "..."` value made only of lowercase words (such as `private-password` in a test) counts as made up. Extra private words go in `terms.local.json` (gitignored). `/secrets` shows what is checked

### Review

- `skills/simplify/` — makes a change smaller and plainer without changing what it does, then runs the tests. `/skill:simplify`
- `skills/review/` — finds bugs, checks the change against what was intended, and collects review comments still open on its PR. `/skill:review [PR number]`
- `extensions/reviewed/` — blocks `gh pr create` until simplify has run on the change and review has run after the last edit. `/reviewed` shows what is missing

### Working across sessions

- `extensions/mailbox/` — lets pi sessions on the same Mac leave letters for each other (stored in `~/.pi/agent/mailbox/`)
  - `/sessions` lists sessions with each one's current focus; `/send <name> <message>` sends a letter. Name a session with pi's `/name <name>`
  - A letter from a human makes the receiving AI act right away; a letter from an AI is only attached to the receiver's next request

### Looking back

- `tools/friction/` — a daily report of where pi sessions went wrong between you and the AI: pushback ("違う", "言ったよね"), requests asked again, "コミットした？" style status checks, runs stopped with Esc, the same block hit more than once, and replies the harness sent back. Each moment comes with the AI's words just before it
  - `make schedule-friction` runs it every morning at 9:00 with launchd; `make friction` runs it now; `make unschedule-friction` stops it
  - Reports go to `~/.pi/agent/friction/` and are never committed, because they quote your sessions. Sessions started from a temporary directory are left out

### Usage and voice

- `extensions/limits/` — shows how much of the current provider's subscription quota is left, in the footer (e.g. `5h 88% left · wk 66% left`)
  - ChatGPT: asks the Codex CLI app-server (requires a Codex CLI login)
  - Claude: read from response headers
  - `/limits` shows reset times, reset credits, and the plan for each provider
- `extensions/voice/` — push-to-talk voice input and read-aloud, tuned for Japanese
  - Hold space to record and release to transcribe into the editor. Esc cancels while recording
  - `/read` reads the last reply aloud. Esc or `/read` stops it
  - Uses the voice bundled with the Alora app (VOICEVOX: Nemo) when it is installed, otherwise macOS `say`

## Setup

```bash
make        # build the voice input helper (macOS 26 or later, Apple Silicon)
make link   # link agent/APPEND_SYSTEM.md into ~/.pi/agent/
make test   # run extension and tool tests (needs pi installed)
make schedule-friction  # optional: the daily friction report
pi install /path/to/pi-harness
```

Pick the `zenkai` theme in pi's `/settings`.

## Requirements

- Voice input: microphone permission for your terminal app (asked on first use)
- Read-aloud with VOICEVOX: `/Applications/Alora.app` (falls back to macOS `say` without it)
- Quota for ChatGPT: the `codex` CLI, logged in
