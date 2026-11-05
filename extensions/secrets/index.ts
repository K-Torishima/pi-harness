/**
 * secrets: keep secrets out of the AI's context, and keep secrets and personal details out of what leaves the machine
 *
 * - Inbound: tokens, keys, and private keys in any tool output are replaced with "[redacted <kind>]" before the AI sees them
 *   (and before they reach the session log). Writing that marker back into a file is blocked, so a real value is never overwritten
 * - Outbound: before git commit, git push, and gh pr create, the lines the change adds are scanned for secrets,
 *   files that usually hold secrets (.env, id_rsa, *.pem), absolute paths under your home directory, and your git email.
 *   A push or PR scans every commit it sends, so a secret added and later removed is still caught.
 *   If anything is found, or the check itself cannot run, the command is blocked
 * - Extra private words to look for (names of private repos, clients, and so on) go in terms.local.json next to this file (gitignored),
 *   as a JSON array of strings
 *
 * Commands you type yourself with ! are never checked. /secrets shows what is checked.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addScope, commandDir, type Finding, type Outgoing, outgoingActions, type PersonalTerms, redact, scanDiff } from "./patterns.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TERMS_FILE = join(HERE, "terms.local.json");
// Untracked files bigger than this are not read
const MAX_FILE = 1024 * 1024;
const MARKER = "[redacted ";

class CheckFailed extends Error {}

/** Run git and return its output; throw CheckFailed when it fails, so the caller blocks instead of letting it through */
function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
	} catch (e) {
		throw new CheckFailed(`git ${args.slice(0, 2).join(" ")} failed in ${cwd}: ${(e as Error).message.split("\n")[0]}`);
	}
}

/** Like git, but a failure means "no such thing" (an upstream or remote branch that does not exist) */
function gitMaybe(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args).trim() || undefined;
	} catch {
		return undefined;
	}
}

function personalTerms(cwd: string): PersonalTerms {
	const email = gitMaybe(cwd, ["config", "user.email"]);
	let terms: string[] = [];
	try {
		if (existsSync(TERMS_FILE)) terms = (JSON.parse(readFileSync(TERMS_FILE, "utf8")) as unknown[]).filter((t): t is string => typeof t === "string");
	} catch {
		// A broken terms file should not stop work; /secrets reports it
	}
	return { homeDir: homedir(), emails: email && !/noreply/i.test(email) ? [email] : [], terms };
}

/** Untracked files (all, or under the given paths) as a diff that adds every line */
function untrackedAsDiff(cwd: string, paths: string[]): string {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const files = git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...(paths.length > 0 ? paths : [":/"])])
		.split("\0")
		.filter(Boolean);
	const parts: string[] = [];
	for (const f of files) {
		const path = join(top, f);
		try {
			if (statSync(path).size > MAX_FILE) continue;
			const text = readFileSync(path, "utf8");
			if (text.includes("\0")) continue;
			const lines = text.split("\n");
			parts.push(`+++ b/${f}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`));
		} catch {
			// Unreadable files are skipped
		}
	}
	return parts.join("\n");
}

/** What a commit in this command would record: what is staged, plus what its own `git add` / `-a` takes in */
function commitDiff(cwd: string, command: string): string {
	const parts = [git(cwd, ["diff", "--cached", "-U0", "--no-color"])];
	const { all, paths } = addScope(command);
	if (all) parts.push(git(cwd, ["diff", "-U0", "--no-color"]), untrackedAsDiff(cwd, []));
	else if (paths.length > 0) parts.push(git(cwd, ["diff", "-U0", "--no-color", "--", ...paths]), untrackedAsDiff(cwd, paths));
	return parts.join("\n");
}

/** Every commit a push or PR would send, each with its own diff, so a secret added and later removed still shows */
function historyDiff(cwd: string, action: "push" | "pr"): string {
	let base = action === "push" ? gitMaybe(cwd, ["rev-parse", "--verify", "-q", "@{u}"]) : undefined;
	for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
		if (base) break;
		base = gitMaybe(cwd, ["merge-base", "HEAD", ref]);
	}
	// No remote yet: everything in HEAD goes out
	const range = base ? `${base}..HEAD` : "HEAD";
	return git(cwd, ["log", "-p", "-U0", "--no-color", "--format=", range]);
}

const describe = (f: Finding) => `${f.file}${f.line > 0 ? `:${f.line}` : ""} — ${f.what}`;

/** The text an edit or write would put into a file */
function newText(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "write") return String(input.content ?? "");
	const edits = Array.isArray(input.edits) ? (input.edits as { newText?: unknown }[]) : [input as { newText?: unknown }];
	return edits.map((e) => String(e.newText ?? "")).join("\n");
}

export default function (pi: ExtensionAPI) {
	// Inbound: hide secrets in every tool result
	pi.on("tool_result", async (event, ctx) => {
		const content = event.content as { type: string; text?: string }[] | undefined;
		if (!Array.isArray(content)) return undefined;
		const found: string[] = [];
		const next = content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const r = redact(part.text);
			found.push(...r.found);
			return r.found.length > 0 ? { ...part, text: r.text } : part;
		});
		if (found.length === 0) return undefined;
		if (ctx.hasUI) ctx.ui.notify(`secrets: hid ${[...new Set(found)].join(", ")} in ${event.toolName} output`, "warning");
		return { content: next };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		// A redaction marker written back would replace the real value on disk
		if ((event.toolName === "edit" || event.toolName === "write") && newText(event.toolName, input).includes(MARKER)) {
			return {
				block: true,
				reason: `Blocked by secrets: the new text contains a "${MARKER}...]" marker. The real value is hidden from you, and writing the marker would overwrite it. Change the file without touching that line, or ask the user to do that part.`,
			};
		}

		if (event.toolName !== "bash") return undefined;
		const command = String(input.command ?? "");
		const actions = outgoingActions(command);
		if (actions.length === 0) return undefined;
		const cwd = resolve(ctx.cwd, commandDir(command, homedir()) ?? ".");

		const findings: Finding[] = [];
		try {
			const terms = personalTerms(cwd);
			for (const action of actions) findings.push(...scanDiff(action === "commit" ? commitDiff(cwd, command) : historyDiff(cwd, action), terms));
		} catch (e) {
			if (!(e instanceof CheckFailed)) throw e;
			if (ctx.hasUI) ctx.ui.notify(`secrets: could not check ${actions.join(" + ")}`, "warning");
			return {
				block: true,
				reason: `Blocked by secrets: could not check what this ${actions.join(" + ")} would send (${e.message}). Run it from inside the repository so the check can read it, or ask the user to run it themselves with !.`,
			};
		}
		if (findings.length === 0) return undefined;

		const unique = [...new Map(findings.map((f) => [describe(f), f])).values()];
		const list = unique.slice(0, 10).map((f) => `- ${describe(f)}`);
		if (unique.length > 10) list.push(`- ... and ${unique.length - 10} more`);
		if (ctx.hasUI) ctx.ui.notify(`secrets: blocked ${actions.join(" + ")} (${unique.length} found)`, "warning");
		const sendsHistory = actions.some((a: Outgoing) => a !== "commit");
		return {
			block: true,
			reason: [
				`Blocked by secrets: this ${actions.join(" + ")} would send out secrets or personal details:`,
				...list,
				sendsHistory
					? "Remove them, and rewrite the commits that added them, before sending. Do not push the history as is."
					: "Remove them from the change first.",
				"If one is a false positive, tell the user which line and why, and let them decide.",
			].join("\n"),
		};
	});

	pi.registerCommand("secrets", {
		description: "Show what secrets checks before commit, push, and PR",
		handler: async (_args, ctx: ExtensionContext) => {
			const p = personalTerms(ctx.cwd);
			const lines = [
				"Hidden in tool output: private keys, AWS / GitHub / npm / Slack / Google / Stripe / sk- keys, JWTs",
				"Blocked before commit, push, PR: the above, hard-coded secret values (not lowercase words like private-password), lines added to .env / key files,",
				`  paths under ${p.homeDir}, ${p.emails?.length ? p.emails.join(", ") : "(no personal git email)"}, and ${p.terms?.length ?? 0} private terms from terms.local.json`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
