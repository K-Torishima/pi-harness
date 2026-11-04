/**
 * Pure rules for mandate: what a tool call does, whether a quote really comes from the user,
 * and whether a reply ends by asking for permission. No pi imports, so tests can load it directly.
 *
 * This is a scope boundary, not a security boundary (guard handles the "never" list).
 * Detection is best effort: a command hidden inside `bash -c '...'` or a script can slip through.
 */

export type Mode = "look" | "plan" | "do";
export const MODES: readonly Mode[] = ["look", "plan", "do"];

/** Kinds of outward actions. Each one needs its own grant from the user */
export type Grant = "push" | "pr" | "issue" | "deploy" | "api";
export const GRANTS: readonly Grant[] = ["push", "pr", "issue", "deploy", "api"];

export type Effect =
	| { kind: "read" }
	| { kind: "local"; label: string }
	| { kind: "outward"; grant: Grant; label: string };

/** Drop heredoc bodies, so text inside a script or message does not look like a command */
export function stripHeredocs(cmd: string): string {
	return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2");
}

/** Drop quoted strings, so `rg "rm -rf"` or `jq '.a > 1'` do not look like writes */
export function stripQuoted(cmd: string): string {
	return cmd.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Split a command line into simple commands at ; && || | newlines and $( */
function segments(cmd: string): string[] {
	return cmd
		.split(/;|&&|\|\||\||\n|\$\(|`/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// The start of a simple command: env assignments and wrappers such as `time` or `xargs -0`
const LEAD = String.raw`^(?:\w+=\S*\s+)*(?:(?:command|time|nohup|xargs(?:\s+-\S+)*)\s+)?`;

const OUTWARD: { grant: Grant; label: string; re: RegExp }[] = [
	{ grant: "push", label: "git push", re: /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+push\b/ },
	{ grant: "pr", label: "gh pr (write)", re: /\bgh\s+pr\s+(?:create|merge|close|reopen|edit|comment|review|ready)\b/ },
	{ grant: "issue", label: "gh issue (write)", re: /\bgh\s+issue\s+(?:create|edit|comment|close|reopen|delete|transfer|lock|unlock|pin|unpin)\b/ },
	{ grant: "deploy", label: "gh release / workflow", re: /\bgh\s+(?:release\s+(?:create|edit|delete|upload)|workflow\s+run|run\s+(?:rerun|cancel))\b/ },
	{
		grant: "deploy",
		label: "deploy",
		re: /\b(?:wrangler\s+(?:deploy|publish|pages\s+deploy|versions\s+deploy|secret\s+put)|npm\s+publish|eas\s+(?:submit|update|build)|firebase\s+deploy|vercel\s+(?:deploy|--prod)|terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete|create|patch|scale|rollout)|fly(?:ctl)?\s+deploy)\b/,
	},
];

const LOCAL: { label: string; re: RegExp }[] = [
	{ label: "file change", re: new RegExp(`${LEAD}(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|tee|dd|install|patch|unzip|tar\\s+-?x)\\b`) },
	{ label: "in-place edit", re: new RegExp(`${LEAD}(?:g?sed|perl)\\b.*\\s-[a-zA-Z]*i`) },
	{
		label: "git (write)",
		re: new RegExp(
			`${LEAD}git(?:\\s+-[Cc]\\s+\\S+)*\\s+(?:add|commit|merge|rebase|reset|checkout|switch|apply|am|cherry-pick|revert|pull|clean|restore|rm|mv|init|clone|stash(?:\\s+(?:push|pop|apply|drop|clear|save)|\\s*$)|tag\\s+(?!-l\\b|--list\\b)\\S|branch\\s+-[dDmMcC]|worktree\\s+(?:add|remove|move|prune))\\b`,
		),
	},
	{ label: "package install", re: new RegExp(`${LEAD}(?:(?:npm|pnpm|yarn|bun)\\s+(?:i|install|add|remove|rm|uninstall|update|upgrade|link|ci)|pip3?\\s+install|brew\\s+(?:install|uninstall|upgrade|remove|reinstall))\\b`) },
];

/** Does an `api` style call write to a remote service? */
function apiWrite(raw: string): string | undefined {
	for (const seg of segments(raw)) {
		if (/^(?:\w+=\S*\s+)*gh\s+api\b/.test(seg)) {
			if (/\bgraphql\b/.test(seg)) {
				if (/\bmutation\b/.test(seg)) return "gh api graphql mutation";
				continue;
			}
			if (/(?:-X|--method)\s*=?\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(seg) || /\s(?:-f|-F|--field|--raw-field|--input)\b/.test(seg)) return "gh api (write)";
		}
		if (/^(?:\w+=\S*\s+)*curl\b/.test(seg)) {
			if (/(?:-X|--request)\s*=?\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i.test(seg) || /\s(?:-d|--data\S*|-F|--form|-T|--upload-file|--json)\b/.test(seg)) return "curl (write)";
		}
	}
	return undefined;
}

/** Output redirection to a file (not /dev/null, not 2>&1) */
function redirects(unquoted: string): boolean {
	const cleaned = unquoted
		.replace(/\d*&?>>?\s*\/dev\/null/g, "")
		.replace(/\d*>&\d/g, "")
		.replace(/<<\w+/g, "");
	return /(?:^|[^<>=\-])>{1,2}(?!=)/.test(cleaned);
}

/** What a bash command does: read only, change local files, or reach outside */
export function classifyCommand(command: string): Effect {
	const raw = stripHeredocs(command);
	// Outward checks keep quoted text, so `sh -c 'git push'` is still caught (fail closed)
	for (const { grant, label, re } of OUTWARD) if (re.test(raw)) return { kind: "outward", grant, label };
	const api = apiWrite(raw);
	if (api) return { kind: "outward", grant: "api", label: api };

	const unquoted = stripQuoted(raw);
	for (const seg of segments(unquoted)) {
		for (const { label, re } of LOCAL) if (re.test(seg)) return { kind: "local", label };
	}
	if (redirects(unquoted)) return { kind: "local", label: "write to a file with >" };
	return { kind: "read" };
}

/** What a tool call does. Unknown tools count as read only (mandate does not guess) */
export function classifyTool(toolName: string, input: Record<string, unknown>): Effect {
	if (toolName === "edit" || toolName === "write") return { kind: "local", label: `${toolName} ${String(input.path ?? "")}`.trim() };
	if (toolName === "bash") return classifyCommand(String(input.command ?? ""));
	return { kind: "read" };
}

/** Lower-case, unify full-width characters, and drop spaces and punctuation */
export function normalize(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Is the quote really part of what the user said? */
export function quoteMatches(quote: string, userText: string): boolean {
	const q = normalize(quote);
	return q.length > 0 && normalize(userText).includes(q);
}

const ASKS = [
	/て(?:も)?(?:よい|いい|良い|よろしい|大丈夫|ok)(?:です|でしょう)?(?:か|[？?])/i,
	/よろしいですか/,
	/(?:進め|始め|実行し|着手し|対応し)(?:ます|ましょう)か/,
	/(?:しましょうか|やりましょうか)/,
	/指示してください|と(?:送|言)ってください|ご指示ください/,
	/\b(?:shall i|should i (?:go ahead|proceed|continue)|do you want me to|want me to|let me know if you(?:'d| would) like|ready (?:for me )?to proceed)\b/i,
];

/** Does the end of a reply ask the user for permission to go on? */
export function asksPermission(reply: string): boolean {
	const tail = reply.slice(-300);
	return ASKS.some((re) => re.test(tail));
}
