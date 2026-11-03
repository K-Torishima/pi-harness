/**
 * mailbox: let pi sessions running on the same Mac leave letters for each other
 *
 * - `/sessions` lists running sessions with each one's current focus (from anchor)
 * - `/send <name> <message>` sends a letter to another session. A letter sent by a human makes the receiving AI act on it right away
 * - The AI sends with send_to_session and finds peers with list_sessions. A letter sent by an AI is only attached to the
 *   receiver's next request and never starts its AI on its own (so two AIs cannot reply to each other forever)
 * - A session is called by the name set with pi's `/name <name>`, or by its folder name if it has none
 *
 * Everything lives in ~/.pi/agent/mailbox/: a name card per session in sessions/, and incoming letters in inbox/<id>/.
 */

import { randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROOT = join(homedir(), ".pi", "agent", "mailbox");
const SESSIONS = join(ROOT, "sessions");
const INBOX = join(ROOT, "inbox");

type Card = { id: string; name: string; cwd: string; pid: number; focus: string; updatedAt: string };
type Letter = { from: { id: string; name: string }; text: string; byHuman: boolean; sentAt: string };

const home = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** Write under a temporary name and rename, so readers never see a half-written file */
function writeJson(path: string, data: unknown) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data));
	renameSync(tmp, path);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read the name cards of running sessions, cleaning up cards of sessions that have stopped */
function liveCards(): Card[] {
	mkdirSync(SESSIONS, { recursive: true });
	const cards: Card[] = [];
	for (const file of readdirSync(SESSIONS)) {
		if (!file.endsWith(".json")) continue;
		const path = join(SESSIONS, file);
		try {
			const card = JSON.parse(readFileSync(path, "utf8")) as Card;
			if (alive(card.pid)) cards.push(card);
			else unlinkSync(path);
		} catch {
			// Skip broken cards
		}
	}
	return cards;
}

export default function (pi: ExtensionAPI) {
	let me: Card | undefined;
	let ctxRef: ExtensionContext | undefined;
	let watcher: FSWatcher | undefined;
	let draining = false;

	const saveCard = () => {
		if (!me) return;
		me.updatedAt = new Date().toISOString();
		mkdirSync(SESSIONS, { recursive: true });
		writeJson(join(SESSIONS, `${me.id}.json`), me);
	};

	/** Find the recipient by exact name, then name prefix, then id prefix, then folder name */
	const resolve = (to: string): { card?: Card; error?: string } => {
		const others = liveCards().filter((c) => c.id !== me?.id);
		const q = to.trim().toLowerCase();
		const tries = [
			(c: Card) => c.name.toLowerCase() === q,
			(c: Card) => c.name.toLowerCase().startsWith(q),
			(c: Card) => c.id.startsWith(q),
			(c: Card) => basename(c.cwd).toLowerCase() === q,
		];
		for (const match of tries) {
			const hits = others.filter(match);
			if (hits.length === 1) return { card: hits[0] };
			if (hits.length > 1) return { error: `More than one session matches "${to}": ${hits.map((c) => c.name).join(", ")}` };
		}
		const names = others.map((c) => c.name).join(", ") || "(no other sessions are running)";
		return { error: `No session called "${to}". Running now: ${names}` };
	};

	const send = (to: string, text: string, byHuman: boolean): string => {
		if (!me) return "The session has not started yet.";
		const { card, error } = resolve(to);
		if (!card) return error ?? "Recipient not found.";
		const dir = join(INBOX, card.id);
		mkdirSync(dir, { recursive: true });
		const letter: Letter = { from: { id: me.id, name: me.name }, text, byHuman, sentAt: new Date().toISOString() };
		writeJson(join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`), letter);
		return `Sent to "${card.name}".`;
	};

	/** Read incoming letters, oldest first, into the conversation */
	const drain = () => {
		if (!me || !ctxRef || draining) return;
		draining = true;
		try {
			const dir = join(INBOX, me.id);
			mkdirSync(dir, { recursive: true });
			for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
				const path = join(dir, file);
				let letter: Letter;
				try {
					letter = JSON.parse(readFileSync(path, "utf8")) as Letter;
				} catch {
					continue;
				}
				unlinkSync(path);
				const ctx = ctxRef;
				const content = [`[letter from ${letter.from.name}]`, letter.text, "", `(If a reply is needed, send it to "${letter.from.name}" with send_to_session)`].join("\n");
				if (letter.byHuman) {
					// A letter from a human is read and acted on right away
					pi.sendMessage({ customType: "mail", content, display: true }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true });
				} else {
					// A letter from an AI is only attached to the next request
					pi.sendMessage({ customType: "mail", content, display: true }, { deliverAs: "nextTurn" });
				}
				if (ctx.hasUI) ctx.ui.notify(`✉ from ${letter.from.name}: ${letter.text.split("\n")[0].slice(0, 60)}`, "info");
			}
		} finally {
			draining = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		watcher?.close();
		if (me) unlinkCard(me);
		const id = ctx.sessionManager.getSessionId();
		me = { id, name: pi.getSessionName() || basename(ctx.cwd), cwd: ctx.cwd, pid: process.pid, focus: me?.focus ?? "", updatedAt: "" };
		saveCard();
		const dir = join(INBOX, id);
		mkdirSync(dir, { recursive: true });
		watcher = watch(dir, () => drain());
		drain();
	});

	// Also check when pi settles, in case the watcher missed something
	pi.on("agent_settled", async () => drain());

	pi.on("session_shutdown", async () => {
		watcher?.close();
		if (me) unlinkCard(me);
	});

	// Put anchor's current focus on the name card, so /sessions shows what each session is doing
	pi.events.on("anchor:changed", (data) => {
		if (!me) return;
		me.focus = (data as { focus?: string }).focus ?? "";
		saveCard();
	});

	function unlinkCard(card: Card) {
		try {
			unlinkSync(join(SESSIONS, `${card.id}.json`));
		} catch {
			// Already gone is fine
		}
	}

	pi.registerTool({
		name: "send_to_session",
		label: "Send to session",
		description:
			"Send a letter to another pi session running on the same Mac. The recipient is the session's name (look it up with list_sessions). The receiving AI reads it on its next request. Use it only when asked, or when something was decided that another session needs to know.",
		parameters: Type.Object({
			to: Type.String({ description: "Name of the recipient session" }),
			message: Type.String({ description: "The message. Write it so the recipient can understand it without any background" }),
		}),
		async execute(_id, params) {
			return { content: [{ type: "text" as const, text: send(params.to, params.message, false) }], details: {} };
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "List sessions",
		description: "List the other pi sessions running on the same Mac, with their names, folders, and current focus.",
		parameters: Type.Object({}),
		async execute() {
			const others = liveCards().filter((c) => c.id !== me?.id);
			const text = others.length > 0 ? others.map((c) => `- ${c.name} (${home(c.cwd)})${c.focus ? ` focus: ${c.focus}` : ""}`).join("\n") : "No other sessions are running.";
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	pi.registerCommand("sessions", {
		description: "List running pi sessions and the current focus of each",
		handler: async (_args, ctx) => {
			const cards = liveCards();
			const lines = cards.map((c) => `${c.id === me?.id ? "● " : "  "}${c.name}  ${home(c.cwd)}${c.focus ? `  ◎ ${c.focus}` : ""}`);
			ctx.ui.notify(lines.join("\n") || "No sessions are running.", "info");
		},
	});

	pi.registerCommand("send", {
		description: "Send a letter to another session. Its AI reads and acts on it right away (/send <name> <message>)",
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!m) return ctx.ui.notify("Write it as /send <name> <message>. /sessions shows the names.", "info");
			ctx.ui.notify(send(m[1], m[2], true), "info");
		},
	});

	// When the name changes with pi's /name, update the card too. A cleared name falls back to the folder name
	pi.on("session_info_changed", async (event) => {
		if (!me) return;
		me.name = event.name || basename(me.cwd);
		saveCard();
	});
}
