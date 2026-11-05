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

import { commandText, GIT, segments, stripHeredocs, stripQuoted, unwrapShellC } from "../lib/shell.ts";

// The start of a simple command: env assignments and wrappers such as `time` or `nohup`
const LEAD = String.raw`^(?:\w+=\S*\s+)*(?:(?:command|time|nohup)\s+)?`;
// Commands that change files
const CHANGERS = "rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|tee|dd|install|patch|unzip";

const OUTWARD: { grant: Grant; label: string; re: RegExp }[] = [
	{ grant: "push", label: "git push", re: new RegExp(`${GIT}push\\b`) },
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
	{ label: "file change", re: new RegExp(`${LEAD}(?:${CHANGERS}|tar\\s+-?x)\\b`) },
	{ label: "file change via xargs", re: new RegExp(`^(?:\\w+=\\S*\\s+)*xargs\\b.*?\\s(?:${CHANGERS})\\b`) },
	{ label: "find -delete / -exec", re: new RegExp(`^find\\b.*\\s(?:-delete\\b|-exec(?:dir)?\\s+(?:${CHANGERS})\\b)`) },
	{ label: "in-place edit", re: new RegExp(`${LEAD}(?:g?sed|perl)\\b.*\\s-[a-zA-Z]*i`) },
	{
		label: "git (write)",
		// (?![\w-]) and not \b, so git merge-base and git merge-tree (read only) are not read as git merge
		re: new RegExp(
			`${LEAD}${GIT}(?:(?:add|commit|commit-tree|commit-graph|merge-file|merge-index|merge-one-file|checkout-index|merge|rebase|reset|checkout|switch|apply|am|cherry-pick|revert|pull|clean|restore|rm|mv|init|init-db|clone)(?![\\w-])|stash(?:\\s+(?:push|pop|apply|drop|clear|save)|\\s*$)|tag\\s+(?!-l\\b|--list\\b)\\S|branch\\s+-[dDmMcC]|worktree\\s+(?:add|remove|move|prune)\\b)`,
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
			// An explicit method decides; without one, fields (-f / -F) make gh send a POST
			const method = seg.match(/(?:-X|--method)\s*=?\s*['"]?([A-Za-z]+)/)?.[1]?.toUpperCase();
			if (method ? /^(?:POST|PUT|PATCH|DELETE)$/.test(method) : /\s(?:-f|-F|--field|--raw-field|--input)\b/.test(seg)) return "gh api (write)";
		}
		if (/^(?:\w+=\S*\s+)*curl\b/.test(seg)) {
			const method = /(?:-X|--request)\s*=?\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i.test(seg);
			// -d / -F / -T alone or bundled with other short flags, such as -sd
			const body = /\s(?:--data\S*|--form|--upload-file|--json)\b/.test(seg) || /\s-[a-zA-Z]*[dFT][a-zA-Z]*(?=\s|$)/.test(seg);
			if (method || body) return "curl (write)";
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
	const raw = unwrapShellC(stripHeredocs(command));
	// Quoted text is dropped, so a commit message that mentions `git push` is not a push.
	// apiWrite reads quotes, because a GraphQL mutation lives inside one; it only looks at segments that start with gh api / curl
	const unquoted = stripQuoted(raw);
	for (const { grant, label, re } of OUTWARD) if (re.test(unquoted)) return { kind: "outward", grant, label };
	const api = apiWrite(raw);
	if (api) return { kind: "outward", grant: "api", label: api };

	for (const seg of segments(unquoted)) {
		for (const { label, re } of LOCAL) if (re.test(seg)) return { kind: "local", label };
	}
	if (redirects(unquoted)) return { kind: "local", label: "write to a file with >" };
	return { kind: "read" };
}

/** Every simple command in a command line that changes local files, with its label. Unlike classifyCommand, it does not stop at the first one */
export function localChanges(command: string): { label: string; segment: string }[] {
	const out: { label: string; segment: string }[] = [];
	for (const segment of segments(commandText(command))) {
		const hit = LOCAL.find(({ re }) => re.test(segment));
		if (hit) out.push({ label: hit.label, segment });
		else if (redirects(segment)) out.push({ label: "write to a file with >", segment });
	}
	return out;
}

// git commands that record, send, or name code without changing the files. Everything else that changes files
// (pull, cherry-pick, stash pop, apply, checkout <file>, ...) changes the code
const RECORDS_ONLY = new RegExp(`${GIT}(?:add|commit|push|fetch|tag|branch|checkout\\s+-b|switch\\s+-c)\\b`);

/** Does this simple command (one segment from localChanges) change the code itself? */
export const changesCodeSegment = (segment: string): boolean => !RECORDS_ONLY.test(segment);

/** Does any part of this command change the code itself (not just record or send it)? */
export const changesCode = (command: string): boolean => localChanges(command).some(({ segment }) => changesCodeSegment(segment));

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

// A quote must be at least this long (after normalize), or the whole message when the message is shorter
const MIN_QUOTE = 4;

/**
 * Is the quote really part of what the user said?
 * This stops made-up quotes and one-character quotes such as "を". It cannot stop a real phrase
 * from being misread; the status bar shows the quote so the user can see what it was based on.
 */
export function quoteMatches(quote: string, userText: string): boolean {
	const q = normalize(quote);
	const u = normalize(userText);
	return q.length >= Math.min(MIN_QUOTE, u.length) && q.length > 0 && u.includes(q);
}

const ASKS = [
	/て(?:も)?(?:よい|いい|良い|よろしい|大丈夫|ok)(?:です|でしょう)?(?:か|[？?])/i,
	/よろしいですか/,
	/(?:進め|始め|実行し|着手し|対応し)(?:ます|ましょう)か/,
	/(?:しましょうか|やりましょうか)/,
	/指示してください|と(?:送|言)ってください|ご指示ください/,
	/\b(?:shall i|should i (?:go ahead|proceed|continue)|do you want me to|want me to|let me know if you(?:'d| would) like|ready (?:for me )?to proceed)\b/i,
];

// Naming the mode ("look" or "plan" alone are ordinary words, so only as mode names)
const MODE_NAME = /\b(?:look|plan)\s*(?:mode|モード)|[（(](?:look|plan)[）)]|読み取り専用|閲覧のみ|変更(?:可能|できる)な?(?:モード|指示)|\bread[- ]only\b/i;
// ... and saying it held back because of it
const HELD_BACK = /変更(?:して|は|を)?(?:いません|しません|しませんでした|していない)|変更できません|触って(?:いません|いない)|(?:did not|didn't|won't|will not|can't|cannot) (?:change|edit|modify|touch)|no (?:changes|files) (?:were )?(?:made|changed)|になったら|を受けたら|があれば/i;

/** The sentences at the end of a reply (its last 300 characters), split after 。！？ and at line breaks */
export function lastSentences(reply: string): string[] {
	return reply
		.trim()
		.slice(-300)
		.split(/(?<=[。！!？?])|\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Does the end of the reply say it did not act because of the mode? Both must be in the same sentence */
export function blamesMode(reply: string): boolean {
	return lastSentences(reply).some((s) => MODE_NAME.test(s) && HELD_BACK.test(s));
}

/** Does the end of a reply ask the user for permission to go on? */
export function asksPermission(reply: string): boolean {
	const tail = reply.slice(-300);
	return ASKS.some((re) => re.test(tail));
}

// Outward actions named as something to do: closing an issue, pushing, merging, deploying, publishing.
// Verb forms only, so local work that mentions these words (閉じ括弧, 送信処理, 公開API, マージされた変更) does not count
const OUTWARD_WORDS =
	/(?:イシュー|issue|PR|プルリク)[^。？?]{0,20}(?:閉じ|クローズ)|(?:閉じ|クローズし)[^。？?]{0,20}(?:イシュー|issue|PR)|として(?:閉じ|クローズ)|クローズし|プッシュ|\bpush\b|マージし|デプロイ|本番(?:に|へ)|リリースし|公開し|送信し|投稿し|コメントし|(?:PR|イシュー|issue)を?(?:作|立て|出)|\b(?:close|merge|deploy|release|publish)\b/i;

/** Does the last question of the reply ask about an outward action? That is the user's call even in look mode */
export function asksOutward(reply: string): boolean {
	const question = lastSentences(reply)
		.filter((s) => /[？?]$/.test(s) || ASKS.some((re) => re.test(s)))
		.at(-1);
	return question !== undefined && OUTWARD_WORDS.test(question);
}
