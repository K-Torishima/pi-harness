/**
 * reviewed: no PR until the change has been simplified, reviewed, and checked for security
 *
 * "Always run review and simplify before a PR" kept being asked for in words and kept being skipped,
 * so this makes it a gate instead of a request.
 *
 * - Counts as a change: a successful edit / write, or any part of a bash command that changes files,
 *   including git commands that bring in code (pull, cherry-pick, stash pop, apply). git add / commit / push / fetch / tag do not count
 * - Counts as a run: the skill is loaded (/skill:<name> typed by you, or the AI reading skills/<name>/SKILL.md) and
 *   its report then starts ("Simplified:" / "Verdict:" / "Security:"), so reading the file alone opens nothing.
 *   simplify counts at its report, after its own edits, so the edits it makes do not ask for another simplify
 * - gh pr create is blocked unless simplify ran after the first change since the last PR,
 *   and review and security ran after the last change (fixing what they found needs another run)
 *
 * /reviewed shows where things stand. Commands you type yourself with ! are never blocked.
 */

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textOf } from "../lib/request.ts";
import { commandText } from "../lib/shell.ts";
import { changesCode } from "../mandate/rules.ts";

const SKILLS = ["simplify", "review", "security"] as const;
type Skill = (typeof SKILLS)[number];

/** The line each skill's report starts with */
const REPORT: Record<Skill, RegExp> = {
	simplify: /^[\W_]*Simplified\s*:/m,
	review: /^[\W_]*Verdict\s*:/m,
	security: /^[\W_]*Security\s*:/m,
};

const names = SKILLS.join("|");
export const SKILL_FILE = new RegExp(`(?:^|/)skills/(${names})/SKILL\\.md$`);
// Not \b: /skill:security-notes is another skill
const SKILL_COMMAND = new RegExp(`^/skill:(${names})(?=\\s|$)`);
const PR_CREATE = /\bgh\s+pr\s+create\b/;

export default function (pi: ExtensionAPI) {
	// A counter, so "after" means "later in this session" without trusting clocks
	let seq = 0;
	let lastChange = 0;
	let firstChange = 0;
	const ran = {} as Record<Skill, number>;
	// Skills loaded whose report has not come yet
	const loaded = new Set<Skill>();

	const reset = () => {
		seq = 0;
		lastChange = 0;
		firstChange = 0;
		for (const skill of SKILLS) ran[skill] = 0;
		loaded.clear();
	};
	reset();

	const changed = () => {
		seq += 1;
		lastChange = seq;
		if (firstChange === 0) firstChange = seq;
	};
	const marked = (skill: Skill) => {
		seq += 1;
		ran[skill] = seq;
	};
	// A skill counts when its report starts; until then it is only loaded
	const load = (skill: Skill) => loaded.add(skill);

	/** What is still missing before a PR, or an empty list. simplify must follow the first change; the others the last */
	const missing = (): string[] =>
		SKILLS.filter((skill) => ran[skill] === 0 || ran[skill] < (skill === "simplify" ? firstChange : lastChange)).map(
			(skill) => `${skill} (read skills/${skill}/SKILL.md, follow it, and report in its format)`,
		);

	pi.on("session_start", async () => reset());

	pi.on("input", async (event) => {
		const m = event.text.trim().match(SKILL_COMMAND);
		if (m) load(m[1] as Skill);
		return { action: "continue" as const };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "read") {
			// Resolved the way pi's read tool does (a leading @ dropped, relative to cwd), so polish's skills/polish/../review/SKILL.md counts
			const m = resolve(ctx.cwd, String(input.path ?? "").replace(/^@/, "")).match(SKILL_FILE);
			if (m) load(m[1] as Skill);
		} else if (event.toolName === "edit" || event.toolName === "write") {
			changed();
		} else if (event.toolName === "bash") {
			const command = String(input.command ?? "");
			// Once a PR is open, the next one only needs simplify again for changes made after it
			if (PR_CREATE.test(commandText(command))) firstChange = 0;
			if (changesCode(command)) changed();
		}
		return undefined;
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant" || loaded.size === 0) return undefined;
		const text = textOf(message.content);
		for (const skill of loaded) {
			if (REPORT[skill].test(text)) {
				loaded.delete(skill);
				marked(skill);
			}
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!PR_CREATE.test(commandText(command))) return undefined;
		const todo = missing();
		if (todo.length === 0) return undefined;
		if (ctx.hasUI) ctx.ui.notify(`reviewed: PR blocked until ${todo.map((t) => t.split(" ")[0]).join(", ")} run`, "warning");
		return {
			block: true,
			reason: `Blocked by reviewed: before opening a PR, run ${todo.join(", then ")} on this change, fix what they find, and try again. Simplify first; review and security after the last change.`,
		};
	});

	pi.registerCommand("reviewed", {
		description: "Show whether simplify, review, and security have run since the last change",
		handler: async (_args, ctx) => {
			const todo = missing();
			ctx.ui.notify(todo.length === 0 ? "Ready for a PR: simplify, review, and security are up to date." : `Before a PR: ${todo.join("; ")}`, "info");
		},
	});
}
