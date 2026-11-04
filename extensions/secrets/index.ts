/**
 * secrets: keep secrets out of the AI's context, and keep secrets and personal details out of what leaves the machine
 *
 * - Inbound: tokens, keys, and private keys in any tool output are replaced with "[redacted <kind>]" before the AI sees them
 *   (and before they reach the session log)
 * - Outbound: before git commit, git push, and gh pr create, the lines the change adds are scanned for secrets,
 *   files that usually hold secrets (.env, id_rsa, *.pem), absolute paths under your home directory, and your git email.
 *   If anything is found, the command is blocked with a list of where
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
import { commandDir, type Finding, type Outgoing, outgoingAction, type PersonalTerms, redact, scanDiff } from "./patterns.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TERMS_FILE = join(HERE, "terms.local.json");
// Untracked files bigger than this are not read
const MAX_FILE = 1024 * 1024;

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function personalTerms(cwd: string): PersonalTerms {
	const email = git(cwd, ["config", "user.email"])?.trim();
	let terms: string[] = [];
	try {
		if (existsSync(TERMS_FILE)) terms = (JSON.parse(readFileSync(TERMS_FILE, "utf8")) as unknown[]).filter((t): t is string => typeof t === "string");
	} catch {
		// A broken terms file should not stop work; /secrets reports it
	}
	return { homeDir: homedir(), emails: email && !/noreply/i.test(email) ? [email] : [], terms };
}

/** Untracked files as a diff that adds every line */
function untrackedAsDiff(cwd: string): string {
	const files = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])?.split("\0").filter(Boolean) ?? [];
	const parts: string[] = [];
	for (const f of files) {
		const path = join(cwd, f);
		try {
			if (statSync(path).size > MAX_FILE) continue;
			const text = readFileSync(path, "utf8");
			if (text.includes("\0")) continue;
			parts.push(`+++ b/${f}`, "@@ -0,0 +1 @@", ...text.split("\n").map((l) => `+${l}`));
		} catch {
			// Unreadable files are skipped
		}
	}
	return parts.join("\n");
}

/** The commit outgoing work is compared against: the upstream, else where the branch left the default branch */
function baseOf(cwd: string, action: Outgoing): string | undefined {
	if (action === "push" && git(cwd, ["rev-parse", "--verify", "-q", "@{u}"])) return "@{u}";
	for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
		const base = git(cwd, ["merge-base", "HEAD", ref])?.trim();
		if (base) return base;
	}
	return undefined;
}

/** What the command would send out, as a diff of added lines */
export function outgoingDiff(cwd: string, action: Outgoing, command: string): string | undefined {
	if (action === "commit") {
		// `git add ... && git commit` or `commit -a` stages more than the index holds right now, so look at everything that could go in
		const widens = /\bgit\b[^;&|]*\s(?:add\b|commit\b[^;&|]*\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)\b)/.test(command);
		const staged = git(cwd, ["diff", "--cached", "-U0", "--no-color"]);
		if (staged === undefined) return undefined;
		return widens ? [git(cwd, ["diff", "HEAD", "-U0", "--no-color"]) ?? staged, untrackedAsDiff(cwd)].join("\n") : staged;
	}
	const base = baseOf(cwd, action);
	if (base) return git(cwd, ["diff", base, "HEAD", "-U0", "--no-color"]);
	// No remote yet: everything in HEAD goes out
	const empty = git(cwd, ["hash-object", "-t", "tree", "/dev/null"])?.trim();
	return empty ? git(cwd, ["diff", empty, "HEAD", "-U0", "--no-color"]) : undefined;
}

const describe = (f: Finding) => `${f.file}${f.line > 0 ? `:${f.line}` : ""} — ${f.what}`;

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

	// Outbound: scan what a commit, push, or PR would send
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const action = outgoingAction(command);
		if (!action) return undefined;
		const cwd = resolve(ctx.cwd, commandDir(command) ?? ".");
		const diff = outgoingDiff(cwd, action, command);
		if (diff === undefined) return undefined;
		const findings = scanDiff(diff, personalTerms(cwd));
		if (findings.length === 0) return undefined;

		const list = findings.slice(0, 10).map((f) => `- ${describe(f)}`);
		if (findings.length > 10) list.push(`- ... and ${findings.length - 10} more`);
		if (ctx.hasUI) ctx.ui.notify(`secrets: blocked ${action} (${findings.length} found)`, "warning");
		return {
			block: true,
			reason: [
				`Blocked by secrets: this ${action} would send out secrets or personal details:`,
				...list,
				action === "commit"
					? "Remove them from the change first."
					: "Remove them, and rewrite the commits that added them, before sending. Do not push the history as is.",
				"If one is a false positive, tell the user which line and why, and let them decide.",
			].join("\n"),
		};
	});

	pi.registerCommand("secrets", {
		description: "Show what secrets checks before commit, push, and PR",
		handler: async (_args, ctx: ExtensionContext) => {
			const p = personalTerms(ctx.cwd);
			const lines = [
				"Hidden in tool output: private keys, AWS / GitHub / Slack / Google / Stripe / sk- keys, JWTs",
				"Blocked before commit, push, PR: the above, hard-coded secret values, .env / key files,",
				`  paths under ${p.homeDir}, ${p.emails?.length ? p.emails.join(", ") : "(no personal git email)"}, and ${p.terms?.length ?? 0} private terms from terms.local.json`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
