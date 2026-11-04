/**
 * Pure parts of anchor: the state, the reminder the AI gets before every model call,
 * and spotting a user message that decides or rejects something. No pi imports, so tests can load it directly.
 */

export type Anchor = { focus: string; next: string; decisions: string[]; rejected: string[]; open: string[] };

export const EMPTY: Anchor = { focus: "", next: "", decisions: [], rejected: [], open: [] };

// Older items get pushed out, to keep the reminder short
export const LIMITS = { decisions: 10, rejected: 10, open: 5 } as const;

// Only what every request must follow. Longer instructions belong in APPEND_SYSTEM.md
export const RULES = [
	"Lead with the conclusion in the first sentence",
	"At most 3 key points, and one topic at a time",
	"Before starting work that drifts away from the focus, ask whether that is OK",
	"Do not bring back an option listed under Rejected unless the user does",
];

export function fresh(saved?: Partial<Anchor>): Anchor {
	return {
		focus: saved?.focus ?? "",
		next: saved?.next ?? "",
		decisions: [...(saved?.decisions ?? [])],
		rejected: [...(saved?.rejected ?? [])],
		open: [...(saved?.open ?? [])],
	};
}

/** Add to a list without duplicates, keeping the newest `max` */
export function push(list: string[], text: string, max: number): string[] {
	return [...list.filter((t) => t !== text), text].slice(-max);
}

export type Kind = "decides" | "rejects";

const DECIDES = [
	/(?:に|で)しよう(?!か)|(?:に|で)する(?:わ|ね|よ)?(?:$|[。！!])|で(?:行|い)こう(?!か)|で決(?:定|まり)|に決め(?:た|よう|る)(?!か)|(?:で|が)(?:OK|ok|いい(?:よ|です|ね)?|良い(?:です)?)(?:$|[。！!])/,
	/\b(?:let'?s go with|we(?:'ll| will) (?:use|go with)|we(?:'ve)? decided (?:to|on)|go with \w+ then)\b/i,
];
const REJECTS = [
	/(?:は|も)(?:いらない|要らない|不要|なしで|無しで|使わない|入れない|やめ(?:よう|て|た|る|とこう))|(?:それ|これ|あれ)(?:は)?やめ(?:よう|て|とこう)/,
	/\b(?:don'?t use|no need for|not needed|we won'?t (?:use|do|add))\b/i,
];
// Wavering, asking, or not yet sure: nothing is decided
const UNSURE = [/[?？]\s*$/, /(?:かな|かも|か迷|か悩|検討|どっち|どれ|迷って|悩んで)/, /\b(?:not sure|unsure|haven'?t decided|undecided|maybe|which)\b/i];

/** Does the user's message decide or reject something? A message can do both ("drop Redis, use Postgres") */
export function decisionKinds(text: string): Kind[] {
	const t = text.trim();
	if (!t || UNSURE.some((re) => re.test(t))) return [];
	const kinds: Kind[] = [];
	if (DECIDES.some((re) => re.test(t))) kinds.push("decides");
	if (REJECTS.some((re) => re.test(t))) kinds.push("rejects");
	return kinds;
}

/** The reminder put in front of the AI before every model call */
export function reminder(state: Anchor, pending?: { kinds: Kind[]; text: string }): string {
	const lines = ["[anchor] Re-read this before you act."];
	lines.push(`Current focus: ${state.focus || "(not set — infer it from the request and, if it is clear, set it with set_focus on the anchor tool)"}`);
	if (state.next) lines.push(`Next step decided last time: ${state.next}`);
	if (state.decisions.length > 0) lines.push("Decided (treat as settled, not as proposals):", ...state.decisions.map((d) => `- ${d}`));
	if (state.rejected.length > 0) lines.push("Rejected (do not propose again):", ...state.rejected.map((d) => `- ${d}`));
	if (state.open.length > 0) lines.push("Still open (the user has not decided):", ...state.open.map((d, i) => `${i + 1}. ${d}`));
	if (pending && pending.kinds.length > 0) {
		const quote = pending.text.length > 120 ? `${pending.text.slice(0, 120)}…` : pending.text;
		const what = pending.kinds.map((k) => (k === "decides" ? "decides" : "rejects")).join(" and ");
		const tools = pending.kinds.map((k) => (k === "decides" ? "add_decision" : "add_rejected")).join(" and ");
		lines.push(
			`The user's latest message looks like it ${what} something: "${quote}". If it does, record it with ${tools} on the anchor tool, one sentence each, before going on. If it only wavers or asks, record nothing.`,
		);
	}
	lines.push("Rules to keep:", ...RULES.map((r) => `- ${r}`));
	lines.push("Before ending your reply, rewrite the next step in one sentence with set_next on the anchor tool. Put questions you leave for the user in add_open.");
	return lines.join("\n");
}
