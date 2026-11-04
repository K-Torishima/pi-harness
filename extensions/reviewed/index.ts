/**
 * reviewed: no PR until the change has been simplified and reviewed
 *
 * "Always run review and simplify before a PR" kept being asked for in words and kept being skipped,
 * so this makes it a gate instead of a request.
 *
 * - Counts as a change: a successful edit / write, or any part of a bash command that changes files,
 *   including git commands that bring in code (pull, cherry-pick, stash pop, apply). git add / commit / push / fetch / tag do not count
 * - Counts as a run: /skill:simplify or /skill:review typed by you, or the AI reading skills/<name>/SKILL.md
 * - gh pr create is blocked unless simplify ran after the first change since the last PR,
 *   and review ran after the last change (fixing what the review found needs another review)
 *
 * /reviewed shows where things stand. Commands you type yourself with ! are never blocked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandText } from "../lib/shell.ts";
import { changesCode } from "../mandate/rules.ts";

type Skill = "simplify" | "review";

export const SKILL_FILE = /(?:^|\/)skills\/(simplify|review)\/SKILL\.md$/;
const SKILL_COMMAND = /^\/skill:(simplify|review)\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;

export default function (pi: ExtensionAPI) {
	// A counter, so "after" means "later in this session" without trusting clocks
	let seq = 0;
	let lastChange = 0;
	let firstChange = 0;
	const ran: Record<Skill, number> = { simplify: 0, review: 0 };

	const reset = () => {
		seq = 0;
		lastChange = 0;
		firstChange = 0;
		ran.simplify = 0;
		ran.review = 0;
	};

	const changed = () => {
		seq += 1;
		lastChange = seq;
		if (firstChange === 0) firstChange = seq;
	};
	const marked = (skill: Skill) => {
		seq += 1;
		ran[skill] = seq;
	};

	/** What is still missing before a PR, or an empty list */
	const missing = (): string[] => {
		const out: string[] = [];
		if (ran.simplify === 0 || ran.simplify < firstChange) out.push("simplify (read skills/simplify/SKILL.md and follow it)");
		if (ran.review === 0 || ran.review < lastChange) out.push("review (read skills/review/SKILL.md and follow it)");
		return out;
	};

	pi.on("session_start", async () => reset());

	pi.on("input", async (event) => {
		const m = event.text.trim().match(SKILL_COMMAND);
		if (m) marked(m[1] as Skill);
		return { action: "continue" as const };
	});

	pi.on("tool_result", async (event) => {
		if (event.isError) return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "read") {
			const m = String(input.path ?? "").match(SKILL_FILE);
			if (m) marked(m[1] as Skill);
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

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!PR_CREATE.test(commandText(command))) return undefined;
		const todo = missing();
		if (todo.length === 0) return undefined;
		if (ctx.hasUI) ctx.ui.notify(`reviewed: PR blocked until ${todo.map((t) => t.split(" ")[0]).join(" and ")} run`, "warning");
		return {
			block: true,
			reason: `Blocked by reviewed: before opening a PR, run ${todo.join(", then ")} on this change, fix what it finds, and try again. Simplify first, review last.`,
		};
	});

	pi.registerCommand("reviewed", {
		description: "Show whether simplify and review have run since the last change",
		handler: async (_args, ctx) => {
			const todo = missing();
			ctx.ui.notify(todo.length === 0 ? "Ready for a PR: simplify and review are up to date." : `Before a PR: ${todo.join("; ")}`, "info");
		},
	});
}
