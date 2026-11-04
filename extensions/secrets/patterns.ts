/**
 * Pure rules for secrets: what a secret looks like, how to hide it, and how to scan a diff
 * for secrets and personal details. No pi imports, so tests can load it directly.
 */

export type SecretPattern = { name: string; re: RegExp };

/** Shapes that are a secret wherever they appear. Used both to hide tool output and to scan diffs */
export const SECRETS: SecretPattern[] = [
	{ name: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
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

/** Files whose very presence is the problem */
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.pem|credentials\.json|\.npmrc|\.netrc)$/;

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
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			file = raw.replace(/^\+\+\+ (?:b\/)?/, "").trim();
			if (file !== "/dev/null" && SECRET_FILES.test(file)) findings.push({ file, line: 0, what: "a file that usually holds secrets" });
			continue;
		}
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (!raw.startsWith("+")) continue;
		const text = raw.slice(1);
		for (const { name, re } of SECRETS) {
			re.lastIndex = 0;
			if (re.test(text)) findings.push({ file, line, what: name });
		}
		const assigned = text.match(ASSIGNED);
		if (assigned && !PLACEHOLDER.test(assigned[1])) findings.push({ file, line, what: "hard-coded secret value" });
		for (const { value, what } of terms) if (text.includes(value)) findings.push({ file, line, what });
		line++;
	}
	return findings;
}

/** Which outgoing action a bash command is, if any */
export type Outgoing = "commit" | "push" | "pr";

export function outgoingAction(command: string): Outgoing | undefined {
	const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
	const git = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
	if (/\bgh\s+pr\s+create\b/.test(unquoted)) return "pr";
	if (new RegExp(`${git}push\\b`).test(unquoted)) return "push";
	if (new RegExp(`${git}commit\\b`).test(unquoted)) return "commit";
	return undefined;
}

/** The directory a git command runs in: `git -C <dir>` or a leading `cd <dir> &&` */
export function commandDir(command: string): string | undefined {
	return command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1]?.replace(/^['"]|['"]$/g, "") ?? command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)?.[1]?.replace(/^['"]|['"]$/g, "");
}
