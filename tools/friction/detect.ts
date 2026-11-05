/**
 * Find the moments in a pi session where the user and the agent did not understand each other.
 * Pure functions over session log lines, so tests can feed them made-up sessions.
 */

export type Kind = "pushback" | "status-check" | "asked-again" | "interrupted" | "blocked-retry" | "sent-back";

export type Incident = {
	kind: Kind;
	time: string;
	/** What the user wrote, or what the harness said */
	text: string;
	/** The agent's last words before it, when there were any */
	before?: string;
};

/** userTurns counts the user messages after `since` */
export type SessionReport = { cwd: string; userTurns: number; incidents: Incident[] };

/** The user says the agent got it wrong, did not listen, or did something not asked for */
const PUSHBACK =
	/違う|ちがう|そうじゃな|そういうことじゃな|そこじゃな|通じてな|話が通じ|聞いてな|読んでな|言ったよね|言ったじゃん|さっき(?:も)?言|何回|何度も|頼んでな|勝手に|余計な|って言った(?:よね|じゃん|のに)|\bnot what I\b|\bI (?:said|asked)\b|\bthat'?s wrong\b/i;
/** A short question about where the work is: the agent did not make its state visible */
const STATUS = /どこまで|進捗|(?:終わ|おわ)って(?:る|ます)[？?]|(?:した|できた|やった|終わった|直した|入れた)[？?]\s*$/;
const STATUS_MAX = 40;
/** How alike two user messages must be to count as asking again */
const SAME = 0.8;
/** Shorter messages ("お願いします", "OK") repeat on purpose */
const ASKED_MIN = 15;
/** Send-backs from the harness: replies it judged wrong and returned to the agent */
const SENT_BACK = /^\[(?:reply|evidence)\]|^\[mandate\] (?:Your reply|You are in do mode)/;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/** Dice similarity over character bigrams, so small rewordings still match */
export function similarity(a: string, b: string): number {
	const grams = (s: string) => {
		const t = s.replace(/\s+/g, "");
		const out = new Map<string, number>();
		for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
		return out;
	};
	const ga = grams(a);
	const gb = grams(b);
	let total = 0;
	let shared = 0;
	for (const n of ga.values()) total += n;
	for (const [g, n] of gb) {
		total += n;
		shared += Math.min(n, ga.get(g) ?? 0);
	}
	return total === 0 ? 0 : (2 * shared) / total;
}

/** Read one session file's lines. `since` drops incidents at or before that time */
export function readSession(lines: string[], since = ""): SessionReport {
	const report: SessionReport = { cwd: "", userTurns: 0, incidents: [] };
	const add = (i: Incident) => {
		if (i.time > since) report.incidents.push(i);
	};
	let lastAssistant = "";
	let pendingInterrupt: Incident | undefined;
	const recentUser: string[] = [];
	const blocked = new Map<string, { count: number; first: Incident }>();
	for (const raw of lines) {
		let entry: any;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry?.type === "session") {
			report.cwd = String(entry.cwd ?? "");
			continue;
		}
		if (entry?.type === "custom_message") {
			const text = textOf(entry.content);
			if (SENT_BACK.test(text)) add({ kind: "sent-back", time: String(entry.timestamp ?? ""), text: oneLine(text, 300), before: lastAssistant || undefined });
			continue;
		}
		if (entry?.type !== "message" || !entry.message) continue;
		const m = entry.message;
		const time = String(entry.timestamp ?? m.timestamp ?? "");
		if (m.role === "assistant") {
			const text = textOf(m.content);
			if (text.trim()) lastAssistant = oneLine(text, 300);
			if (m.stopReason === "aborted") pendingInterrupt = { kind: "interrupted", time, text: "", before: lastAssistant || undefined };
			continue;
		}
		if (m.role === "toolResult") {
			const text = textOf(m.content);
			if (m.isError && /^Blocked\b/.test(text)) {
				const key = `${m.toolName}\n${text.split("\n")[0]}`;
				const seen = blocked.get(key);
				if (seen) seen.count++;
				else blocked.set(key, { count: 1, first: { kind: "blocked-retry", time, text: oneLine(text, 300) } });
			}
			continue;
		}
		if (m.role !== "user") continue;
		const text = textOf(m.content).trim();
		if (!text) continue;
		if (time > since) report.userTurns++;
		if (pendingInterrupt) {
			add({ ...pendingInterrupt, text: oneLine(text, 300) });
			pendingInterrupt = undefined;
		}
		const before = lastAssistant || undefined;
		const short = oneLine(text, 300);
		if (PUSHBACK.test(text)) add({ kind: "pushback", time, text: short, before });
		else if (text.length <= STATUS_MAX && STATUS.test(text)) add({ kind: "status-check", time, text: short, before });
		else if (text.length >= ASKED_MIN && recentUser.some((u) => similarity(u, text) >= SAME)) add({ kind: "asked-again", time, text: short, before });
		recentUser.push(text);
		if (recentUser.length > 5) recentUser.shift();
	}
	if (pendingInterrupt) add({ ...pendingInterrupt, text: "(no message after it)" });
	for (const { count, first } of blocked.values()) {
		if (count >= 2) add({ ...first, text: `${count}× ${first.text}` });
	}
	return report;
}
