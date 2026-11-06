import { textOf } from "../../extensions/lib/request.ts";

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
	/違う|ちがう|そうじゃな|そういうことじゃな|そこじゃな|通じてな|話が通じ|聞いてな|読んでな|言ったよね|言ったじゃん|さっき(?:も)?言|何回(?:も|言)|何度も|頼んでな|勝手に|余計な|って言った(?:よね|じゃん|のに)|\bnot what I\b|\bI (?:said|asked)\b|\bthat'?s wrong\b/i;
/**
 * Words PUSHBACK matches that are not pushback: "違う" describing a difference ("体験が明らかに違うものとか"),
 * and "勝手に" giving permission ("勝手に調べていいよ")
 */
const GO_AHEAD = /勝手に[^。！!？?、]{0,12}(?:ていい|て良い|てOK|てok|どうぞ)(?!とは|って|と言)/gi;
// Only in a question: "違うところ直してる" and "違うことしないで" are pushback
const DIFFERENCE = /違う(?:もの|点|部分|とか)/g;
const isPushback = (text: string) => {
	let rest = text.replace(GO_AHEAD, "");
	if (/[？?]\s*$/.test(text)) rest = rest.replace(DIFFERENCE, "");
	return PUSHBACK.test(rest);
};
/** A short question about where the work is: the agent did not make its state visible */
const STATUS = /どこまで|進捗|(?:終わ|おわ)って(?:る|ます)[？?]|(?:した|できた|やった|終わった|直した|入れた)[？?]\s*$/;
const STATUS_MAX = 40;
/** Longer messages are pasted logs, pages, or templates, where these words do not speak to the agent */
const TYPED_MAX = 200;
/** How alike two user messages must be to count as asking again */
const SAME = 0.8;
/** Shorter messages ("お願いします", "OK") repeat on purpose */
const ASKED_MIN = 15;
/**
 * Send-backs from the harness: replies it judged wrong and returned to the agent. reply, evidence, and mandate
 * mark them with details.sentBack; the wording is the fallback for logs written before the mark
 */
const SENT_BACK_TEXT = /^\[(?:reply|evidence)\]|^\[mandate\] (?:Your reply|You are in do mode)/;
/** The /goal kickoff, which the goal extension sends as a user message. Its fixed line is checked against goal's source in the tests */
export const GOAL_KICKOFF = "Keep working on your own until this goal is done.";

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

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
	// An interrupt waits for the user's next message, which says why; it is reported at that message's time
	let interruptedAfter: string | undefined;
	const recentUser: string[] = [];
	// Each block is reported at the time it repeated, so a repeat after the last run is not lost
	const blocked = new Map<string, number>();
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
			if (entry.details?.sentBack === true || SENT_BACK_TEXT.test(text)) {
				add({ kind: "sent-back", time: String(entry.timestamp ?? ""), text: oneLine(text, 300), before: lastAssistant || undefined });
			}
			continue;
		}
		if (entry?.type !== "message" || !entry.message) continue;
		const m = entry.message;
		const time = String(entry.timestamp ?? m.timestamp ?? "");
		if (m.role === "assistant") {
			const text = textOf(m.content);
			if (text.trim()) lastAssistant = oneLine(text, 300);
			if (m.stopReason === "aborted") interruptedAfter = lastAssistant;
			continue;
		}
		if (m.role === "toolResult") {
			const text = textOf(m.content);
			if (m.isError && /^Blocked\b/.test(text)) {
				const key = `${m.toolName}\n${text.split("\n")[0]}`;
				const count = (blocked.get(key) ?? 0) + 1;
				blocked.set(key, count);
				if (count >= 2) add({ kind: "blocked-retry", time, text: `${count}× ${oneLine(text, 300)}` });
			}
			continue;
		}
		if (m.role !== "user") continue;
		const text = textOf(m.content).trim();
		// Empty messages and the /goal kickoff were not typed by the user
		if (!text || text.includes(GOAL_KICKOFF)) continue;
		if (time > since) report.userTurns++;
		const short = oneLine(text, 300);
		if (interruptedAfter !== undefined) {
			add({ kind: "interrupted", time, text: short, before: interruptedAfter || undefined });
			interruptedAfter = undefined;
		}
		const before = lastAssistant || undefined;
		const typed = text.length <= TYPED_MAX;
		if (typed && isPushback(text)) add({ kind: "pushback", time, text: short, before });
		else if (text.length <= STATUS_MAX && STATUS.test(text)) add({ kind: "status-check", time, text: short, before });
		else if (typed && text.length >= ASKED_MIN && recentUser.some((u) => similarity(u, text) >= SAME)) add({ kind: "asked-again", time, text: short, before });
		recentUser.push(text);
		if (recentUser.length > 5) recentUser.shift();
	}
	// Several retries of one block in a row are one moment: keep the last report for each block
	const lastRetry = new Map<string, Incident>();
	const rest: Incident[] = [];
	for (const i of report.incidents) {
		if (i.kind === "blocked-retry") lastRetry.set(i.text.replace(/^\d+× /, ""), i);
		else rest.push(i);
	}
	report.incidents = [...rest, ...lastRetry.values()].sort((a, b) => a.time.localeCompare(b.time));
	return report;
}
