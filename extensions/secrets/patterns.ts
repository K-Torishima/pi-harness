/**
 * Pure rules for secrets: what a secret looks like, how to hide it, and how to scan a diff
 * for secrets and personal details. No pi imports, so tests can load it directly.
 */

import { commandText, GIT, segments, unwrapShellC } from "../lib/shell.ts";

export type SecretPattern = { name: string; re: RegExp };

/** Shapes that are a secret wherever they appear. Used both to hide tool output and to scan diffs */
export const SECRETS: SecretPattern[] = [
	// The header plus the base64 body that follows it. A header on its own (code that checks for one) is left alone
	{ name: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{40,}?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|(?=[^A-Za-z0-9+/=\s])|$)/g },
	{ name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
	{ name: "API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/g },
	{ name: "Slack token", re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
	{ name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "Stripe key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
	{ name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** `password = "..."` style assignments. Only checked in diffs, because code that reads them is common in tool output */
const ASSIGNED = /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b\s*[:=]\s*['"]([^'"\s]{12,})['"]/i;
// Values that are obviously placeholders, not real secrets
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{?[\w.]+\}?|your[_-].*|example.*|changeme|dummy.*|test.*|fake.*|placeholder.*)$/i;
// Lowercase words only, such as "private-password" in a test that checks passwords are filtered.
// Generated secrets mix in digits or capitals, so a value without either is treated as made up
const WORDS = /^[a-z]+(?:[-_.][a-z]+)*$/;

/** Replace every secret in a text with a short marker */
export function redact(text: string): { text: string; found: string[] } {
	const found: string[] = [];
	let out = text;
	for (const { name, re } of SECRETS) {
		out = out.replace(re, () => {
			found.push(name);
			return `[redacted ${name}]`;
		});
	}
	return { text: out, found };
}

export type Finding = { file: string; line: number; what: string };

export type PersonalTerms = { homeDir?: string; emails?: string[]; terms?: string[] };

/** Files that usually hold secrets. Adding lines to them is the problem; removing lines is fine */
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.pem|credentials\.json|\.netrc)$/;

// Escapes git uses in quoted paths, other than octal bytes
const UNESCAPE: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const ESCAPE = Object.fromEntries(Object.entries(UNESCAPE).map(([k, v]) => [v, `\\${k}`]));
// Characters that make git quote a path, apart from non-ASCII (the scanner runs git with core.quotePath=false)
const NEEDS_QUOTES = /["\\\x00-\x1f\x7f]/;

/**
 * The path in a `+++ ` header. Git quotes a path that holds `"`, `\`, or control characters, C style with octal bytes.
 * The tab git puts after a name with spaces is dropped; other spaces are part of the name
 */
export function diffPath(header: string): string {
	let path = header.replace(/\t$/, "");
	if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) {
		const bytes: Buffer[] = [];
		for (const part of path.slice(1, -1).match(/\\[0-7]{3}|\\.|[^\\]+/gs) ?? []) {
			if (/^\\[0-7]{3}$/.test(part)) bytes.push(Buffer.from([parseInt(part.slice(1), 8)]));
			else if (part.startsWith("\\")) bytes.push(Buffer.from(UNESCAPE[part[1]] ?? part[1], "utf8"));
			else bytes.push(Buffer.from(part, "utf8"));
		}
		path = Buffer.concat(bytes).toString("utf8");
	}
	return path.replace(/^b\//, "");
}

/** A `+++ ` header for a path, quoted the way git does when it has to be, so diffPath reads it back */
export function diffHeader(path: string): string {
	if (!NEEDS_QUOTES.test(path)) return `+++ b/${path}`;
	const body = [...`b/${path}`].map((ch) => ESCAPE[ch] ?? (ch < " " || ch === "\x7f" ? `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}` : ch)).join("");
	return `+++ "${body}"`;
}

/**
 * Look at the lines a unified diff adds (git diff -U0 output) and report secrets and personal details.
 * Only added lines count; removing a secret is fine.
 */
export function scanDiff(diff: string, personal: PersonalTerms = {}): Finding[] {
	const findings: Finding[] = [];
	const terms = [
		...(personal.homeDir && personal.homeDir.length > 1 ? [{ value: personal.homeDir, what: "absolute path under your home directory" }] : []),
		...(personal.emails ?? []).filter(Boolean).map((e) => ({ value: e, what: "personal email address" })),
		...(personal.terms ?? []).filter(Boolean).map((t) => ({ value: t, what: `private term "${t}"` })),
	];
	let file = "";
	let line = 0;
	// Lines the current hunk still holds. Inside a hunk, a line that looks like a header (`+++ b/x`) is content
	let oldLeft = 0;
	let newLeft = 0;
	// Secret files already reported, so a file is listed once however many lines it gains
	const reported = new Set<string>();
	for (const raw of diff.split("\n")) {
		// A hunk ends when its counts run out, or at any line a hunk cannot hold, so one miscount does not
		// leave the rest of the diff read as hunk content
		if ((oldLeft > 0 || newLeft > 0) && !/^[ +\-\\]/.test(raw)) oldLeft = newLeft = 0;
		if (oldLeft <= 0 && newLeft <= 0) {
			if (raw.startsWith("+++ ")) {
				file = diffPath(raw.slice(4));
				continue;
			}
			const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (hunk) {
				oldLeft = Number(hunk[1] ?? 1);
				line = Number(hunk[2]);
				newLeft = Number(hunk[3] ?? 1);
				continue;
			}
			// Outside a hunk, an added line in a shape this parser does not know is still scanned
			if (!raw.startsWith("+")) continue;
		} else if (raw.startsWith("\\")) {
			continue; // "\ No newline at end of file"
		} else if (raw.startsWith("-")) {
			oldLeft--;
			continue;
		} else if (!raw.startsWith("+")) {
			// A context line belongs to both sides
			oldLeft--;
			newLeft--;
			line++;
			continue;
		} else {
			newLeft--;
		}
		const text = raw.slice(1);
		if (SECRET_FILES.test(file) && !reported.has(file)) {
			reported.add(file);
			findings.push({ file, line: 0, what: "a file that usually holds secrets" });
		}
		for (const { name, re } of SECRETS) {
			re.lastIndex = 0;
			if (re.test(text)) findings.push({ file, line, what: name });
		}
		const assigned = text.match(ASSIGNED);
		if (assigned && !PLACEHOLDER.test(assigned[1]) && !WORDS.test(assigned[1])) findings.push({ file, line, what: "hard-coded secret value" });
		for (const { value, what } of terms) if (text.includes(value)) findings.push({ file, line, what });
		line++;
	}
	return findings;
}

/** Outgoing actions in a bash command. `git commit && git push` is both: the new commit and the history it sends */
export type Outgoing = "commit" | "push" | "pr";

export function outgoingActions(command: string): Outgoing[] {
	const text = commandText(command);
	const out: Outgoing[] = [];
	if (new RegExp(`${GIT}commit\\b`).test(text)) out.push("commit");
	if (new RegExp(`${GIT}push\\b`).test(text)) out.push("push");
	if (/\bgh\s+pr\s+create\b/.test(text)) out.push("pr");
	return out;
}

/**
 * What a commit in this command takes in besides what is staged now:
 * `all` for `git add -A` / `-u` / `commit -a`, otherwise the paths passed to `git add`
 */
export function addScope(command: string): { all: boolean; paths: string[] } {
	let all = false;
	const paths: string[] = [];
	for (const seg of segments(unwrapShellC(command))) {
		const add = seg.match(new RegExp(`${GIT}add\\b(.*)$`));
		if (add) {
			for (const word of add[1].trim().split(/\s+/).filter(Boolean)) {
				if (/^(?:-A|--all|-u|--update)$/.test(word)) all = true;
				else if (!word.startsWith("-")) paths.push(word.replace(/^['"]|['"]$/g, ""));
			}
		}
		if (new RegExp(`${GIT}commit\\b.*\\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)(?:\\s|$)`).test(seg)) all = true;
	}
	return { all, paths };
}

/** The directory a git command runs in: `git -C <dir>` or a leading `cd <dir> &&`, with ~ expanded */
export function commandDir(command: string, home: string): string | undefined {
	const text = unwrapShellC(command);
	const dir = text.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1] ?? text.match(/(?:^|;|&&)\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)?.[1];
	if (!dir) return undefined;
	const bare = dir.replace(/^['"]|['"]$/g, "");
	return bare === "~" || bare === "$HOME" ? home : bare.replace(/^(?:~|\$HOME)\//, `${home}/`);
}
