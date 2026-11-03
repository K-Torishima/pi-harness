# pi-harness

A personal harness for the [pi](https://pi.dev) coding agent, loaded as a local pi package.
It is grown one piece at a time: only things that were actually missed while using pi get added.

## What's inside

### Look and feel

- `extensions/zenkai-code/` — the "ZENKAI CODE" look: a logo that flares up at startup, plus an editor and footer in Hermes Agent's gold and bronze palette. `/zenkai-code` toggles back to pi's default look
- `extensions/quiet-tools/` — folds the output of read, bash, grep, find, and ls into a single "→ 42 lines" line. Failures and anything you expand with Ctrl+O are shown in full
- `themes/zenkai.json` — readable body colors with a fire-orange accent

### Staying on track

- `extensions/anchor/` — pins the current focus, the next step, and what was decided, so neither you nor the AI drifts
  - Shows "◎ focus" and "▸ next" above the editor, and sets the terminal tab title to the focus
  - Has the AI re-read the focus, decisions, and rules before every request; the AI rewrites "next" after every reply
  - `/focus <focus>`, `/decided <decision>`, `/now`, `/anchor clear`. A goal set with `/goal` becomes the focus
- `extensions/goal/` — `/goal <goal>` makes the AI define done criteria and keep working until they hold
  - Stops when the AI reports done or blocked through the goal tool, or on Esc, an error, or after 15 rounds. `/goal` shows the state, `/goal stop` gives up
- `extensions/lens/` — draws one lens card per session (doubt yourself, a better plan, laziness, impatience, hubris, …) and shows it below the editor
  - The AI gets the same card and adds one "Lens:" line to its reply only when it truly applies
  - `/lens` draws again, `/lens add <name>: <question>` adds a card, `/lens list` shows the deck. The deck is `lenses.json`
- `skills/grill/` — grills you one question at a time to align understanding, for designs, reviews, and decisions alike. Run with `/skill:grill`
- `agent/APPEND_SYSTEM.md` — added to pi's system prompt: short replies that lead with the conclusion, picking up lenses, and doubting its own plans. `make link` links it into `~/.pi/agent/`

### Safety

- `extensions/guard/` — blocks only what the AI must never do. Rules live in `rules.json`
  - Blocks `sudo`, `rm -rf`, reading `.env`, force pushes, and git commands that throw away work
  - Personal rules go in `rules.local.json` (gitignored) and are merged in
  - Commands you type yourself with `!` are never blocked. `/guard` lists the rules

### Working across sessions

- `extensions/mailbox/` — lets pi sessions on the same Mac leave letters for each other (stored in `~/.pi/agent/mailbox/`)
  - `/sessions` lists sessions with each one's current focus; `/send <name> <message>` sends a letter. Name a session with pi's `/name <name>`
  - A letter from a human makes the receiving AI act right away; a letter from an AI is only attached to the receiver's next request

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
pi install /path/to/pi-harness
```

Pick the `zenkai` theme in pi's `/settings`.

## Requirements

- Voice input: microphone permission for your terminal app (asked on first use)
- Read-aloud with VOICEVOX: `/Applications/Alora.app` (falls back to macOS `say` without it)
- Quota for ChatGPT: the `codex` CLI, logged in
