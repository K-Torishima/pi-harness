/**
 * anchor: pin the current focus, the next step, and what was decided, rejected, and left open, so neither you nor the AI drifts
 *
 * Where you are:
 * - Always show "◎ focus" and "▸ next step" above the editor
 * - Set the terminal tab title to the focus (so you can tell sessions apart when switching tabs)
 * AI drift:
 * - At the start of every request, the AI gets the focus, what was decided, what was rejected, what is still open,
 *   and the rules to keep, as a hidden message. It is written once and never moved or rewritten, so the prompt cache
 *   holds across the run. When compaction summarizes it away, the same text comes back right after the summary
 * - When your message looks like it decides or rejects something, the AI is asked to record it
 * - The AI rewrites the "next step" with the anchor tool at the end of every reply
 *
 * You use /focus <focus>, /decided <decision>, /rejected <option>, /now (show all), and /anchor clear.
 * A goal set with /goal becomes the focus automatically.
 * The state is saved in the session log, so it comes back when you reopen pi.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Anchor, decisionKinds, fresh, type Kind, LIMITS, push, reminder } from "./ledger.ts";

const AnchorParams = Type.Object({
	action: StringEnum(["set_next", "set_focus", "add_decision", "add_rejected", "add_open", "close_open"] as const),
	text: Type.String({
		description:
			"set_next: the next step / set_focus: the current focus / add_decision: something the user decided / add_rejected: an option the user turned down / add_open: a question left for the user / close_open: the number of the open item that is no longer open. One sentence each",
	}),
});

export default function (pi: ExtensionAPI) {
	let state: Anchor = fresh();
	let current: ExtensionContext | undefined;
	// The user's latest message, when it looks like a decision or rejection that has not been recorded yet
	let pending: { kinds: Kind[]; text: string } | undefined;
	// set_next calls since the last user or extension message (one /goal round counts as one reply)
	let setNextCalls = 0;
	pi.on("message_start", async (event) => {
		const role = (event.message as { role?: string }).role;
		if (role === "user" || role === "custom") setNextCalls = 0;
	});
	const recorded = (kind: Kind) => {
		if (!pending) return;
		pending.kinds = pending.kinds.filter((k) => k !== kind);
		if (pending.kinds.length === 0) pending = undefined;
	};

	const render = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(state.focus ? `π ${state.focus}` : "π");
		if (!state.focus && !state.next) {
			ctx.ui.setWidget("anchor", undefined);
			return;
		}
		const t = ctx.ui.theme;
		const lines: string[] = [];
		if (state.focus) lines.push(`${t.fg("accent", "◎")} ${t.bold(state.focus)}`);
		if (state.next) lines.push(`${t.fg("accent", "▸")} ${t.fg("muted", "next:")} ${state.next}`);
		ctx.ui.setWidget("anchor", lines);
	};

	const save = (ctx: ExtensionContext) => {
		pi.appendEntry("anchor", state);
		pi.events.emit("anchor:changed", { ...state });
		render(ctx);
	};

	const setFocus = (ctx: ExtensionContext, focus: string) => {
		// A new focus clears the previous focus's next step
		if (focus !== state.focus) state.next = "";
		state.focus = focus;
		save(ctx);
	};

	pi.registerTool({
		name: "anchor",
		label: "Anchor",
		description:
			"Update the focus, next step, and the decided / rejected / open lists the user relies on. Before ending a reply, use set_next for the next step. When the user decides something, add_decision; when they turn an option down, add_rejected; when you leave a question for them, add_open; when an open question is settled, close_open with its number. Use set_focus only when the user changes the focus.",
		parameters: AnchorParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { ...state } });
			const text = params.text.trim();
			if (!text) return reply("text is empty.");
			switch (params.action) {
				case "set_next":
					// A safety net against loops: the next step is written once per reply
					setNextCalls += 1;
					if (setNextCalls > 2) return reply("The next step is already set for this reply. Do not call set_next again; finish your reply now.");
					state.next = text;
					break;
				case "set_focus":
					if (text !== state.focus) state.next = "";
					state.focus = text;
					break;
				case "add_decision":
					state.decisions = push(state.decisions, text, LIMITS.decisions);
					recorded("decides");
					break;
				case "add_rejected":
					state.rejected = push(state.rejected, text, LIMITS.rejected);
					recorded("rejects");
					break;
				case "add_open":
					state.open = push(state.open, text, LIMITS.open);
					break;
				case "close_open": {
					const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
					if (!(n >= 1 && n <= state.open.length)) return reply(`Pass the number of one open item (1-${state.open.length}), and nothing else. Call close_open once per item.`);
					state.open = state.open.filter((_, i) => i !== n - 1);
					break;
				}
			}
			save(ctx);
			return reply("Updated.");
		},
	});

	// The reminder is written once per request, next to the user's message, and stays where it is.
	// Rewriting or moving it inside the conversation made the provider re-read everything after the system prompt
	// (about 270 of 1,700 calls in two days), so changes made during a request show up in the next one.
	// Never after a tool result: a trailing "before ending your reply, call set_next" makes the model call it again and again
	let written: string | undefined;
	pi.on("before_agent_start", async () => {
		written = reminder(state, pending);
		return { message: { customType: "anchor", content: written, display: false } };
	});

	// Compaction can summarize the reminder away in a long run. Put the same text back right after the summary,
	// where it stays until the next compaction
	pi.on("context", async (event) => {
		if (!written) return undefined;
		const isAnchor = (m: unknown) => (m as { role?: string; customType?: string }).role === "custom" && (m as { customType?: string }).customType === "anchor";
		if (event.messages.some(isAnchor)) return undefined;
		const roles = event.messages.map((m) => (m as { role?: string }).role);
		const at = Math.max(roles.lastIndexOf("compactionSummary"), roles.lastIndexOf("branchSummary"));
		const messages = [...event.messages];
		messages.splice(at + 1, 0, { role: "custom", customType: "anchor", content: written, display: false, timestamp: 0 } as (typeof messages)[number]);
		return { messages };
	});

	// A message you type that decides or rejects something is flagged until the AI records it
	pi.on("input", async (event) => {
		// A message from an extension (such as the /goal kickoff) is a new instruction too: an older unrecorded decision is no longer "latest"
		const kinds = event.source === "extension" ? [] : decisionKinds(event.text);
		pending = kinds.length > 0 ? { kinds, text: event.text.trim() } : undefined;
		return { action: "continue" as const };
	});

	// Restore the last state saved on the current branch
	const restore = (ctx: ExtensionContext) => {
		current = ctx;
		pending = undefined;
		const last = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "anchor")
			.at(-1) as { data?: Partial<Anchor> } | undefined;
		state = fresh(last?.data);
		render(ctx);
		pi.events.emit("anchor:changed", { ...state });
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	// /tree moves to another branch: its own anchor applies, not the one in memory
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	// A goal set with /goal becomes the focus
	pi.events.on("goal:start", (data) => {
		const objective = (data as { objective?: string }).objective;
		if (current && objective) setFocus(current, objective);
	});

	pi.registerCommand("focus", {
		description: "Set the current focus (/focus <focus>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify(state.focus ? `Current focus: ${state.focus}` : "No focus yet. Set one with /focus <focus>.", "info");
			setFocus(ctx, text);
			ctx.ui.notify(`Focus set to "${text}"`, "info");
		},
	});

	pi.registerCommand("decided", {
		description: "Record a decision. The AI gets it with every request from now on (/decided <decision>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Write it as /decided <decision>.", "info");
			state.decisions = push(state.decisions, text, LIMITS.decisions);
			save(ctx);
			ctx.ui.notify(`Added to decisions: ${text}`, "info");
		},
	});

	pi.registerCommand("rejected", {
		description: "Record an option you turned down, so the AI stops proposing it (/rejected <option>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Write it as /rejected <option>.", "info");
			state.rejected = push(state.rejected, text, LIMITS.rejected);
			save(ctx);
			ctx.ui.notify(`Added to rejected: ${text}`, "info");
		},
	});

	pi.registerCommand("now", {
		description: "Show the focus, next step, and what is decided, rejected, and open",
		handler: async (_args, ctx) => {
			const section = (title: string, items: string[]) => (items.length > 0 ? [`${title}:`, ...items.map((d, i) => `${i + 1}. ${d}`)] : []);
			const lines = [
				`Focus: ${state.focus || "(none)"}`,
				`Next: ${state.next || "(none)"}`,
				...section("Decided", state.decisions),
				...section("Rejected", state.rejected),
				...section("Open", state.open),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("anchor", {
		description: "Clear the anchor (/anchor clear)",
		handler: async (args, ctx) => {
			if (args.trim() !== "clear") return ctx.ui.notify("/anchor clear removes the focus, next step, and the decided / rejected / open lists.", "info");
			state = fresh();
			pending = undefined;
			save(ctx);
			ctx.ui.notify("Anchor cleared", "info");
		},
	});
}
