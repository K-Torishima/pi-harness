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

const DECIDES = [
	/(?:に|で)(?:しよう|する(?:わ|ね|よ)?(?:$|[。、！!]))|で(?:行|い)こう|で決(?:定|まり)|に決め(?:た|よう|る)|(?:で|が)(?:OK|ok|いい(?:よ|です|ね)|良い(?:です)?)(?:$|[。、！!])/,
	/\b(?:let'?s go with|we(?:'ll| will) (?:use|go with)|decided|go with)\b/i,
];
const REJECTS = [
	/(?:は|も)?(?:いらない|要らない|不要|なしで|無しで|やめ(?:よう|て|た|る)|使わない|入れない|しない(?:で|こと)?(?:$|[。、！!]))/,
	/\b(?:don'?t (?:use|add|do)|no need for|drop (?:it|that|the)|not needed|we won'?t)\b/i,
];

/** Does the user's message decide or reject something? Returns which, or undefined */
export function decisionKind(text: string): "decides" | "rejects" | undefined {
	const t = text.trim();
	// Questions ask, they do not decide
	if (!t || /[?？]\s*$/.test(t)) return undefined;
	if (REJECTS.some((re) => re.test(t))) return "rejects";
	if (DECIDES.some((re) => re.test(t))) return "decides";
	return undefined;
}

/** The reminder put in front of the AI before every model call */
export function reminder(state: Anchor, pending?: { kind: "decides" | "rejects"; text: string }): string {
	const lines = ["[anchor] Re-read this before you act."];
	lines.push(`Current focus: ${state.focus || "(not set — infer it from the request and, if it is clear, set it with set_focus on the anchor tool)"}`);
	if (state.next) lines.push(`Next step decided last time: ${state.next}`);
	if (state.decisions.length > 0) lines.push("Decided (treat as settled, not as proposals):", ...state.decisions.map((d) => `- ${d}`));
	if (state.rejected.length > 0) lines.push("Rejected (do not propose again):", ...state.rejected.map((d) => `- ${d}`));
	if (state.open.length > 0) lines.push("Still open (the user has not decided):", ...state.open.map((d, i) => `${i + 1}. ${d}`));
	if (pending) {
		const quote = pending.text.length > 120 ? `${pending.text.slice(0, 120)}…` : pending.text;
		lines.push(
			`The user's latest message looks like it ${pending.kind === "decides" ? "decides" : "rejects"} something: "${quote}". If it does, record it with ${pending.kind === "decides" ? "add_decision" : "add_rejected"} on the anchor tool, in one sentence, before going on.`,
		);
	}
	lines.push("Rules to keep:", ...RULES.map((r) => `- ${r}`));
	lines.push("Before ending your reply, rewrite the next step in one sentence with set_next on the anchor tool. Put questions you leave for the user in add_open.");
	return lines.join("\n");
}
