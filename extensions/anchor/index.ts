/**
 * anchor: pin the current focus, the next step, and what was decided, rejected, and left open, so neither you nor the AI drifts
 *
 * Where you are:
 * - Always show "◎ focus" and "▸ next step" above the editor
 * - Set the terminal tab title to the focus (so you can tell sessions apart when switching tabs)
 * AI drift:
 * - Before every model call, not just every request, the AI re-reads the focus, what was decided, what was rejected,
 *   what is still open, and the rules to keep. It is added to each call and never stored, so long runs, /goal loops,
 *   and compaction do not wash it out
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
import { type Anchor, decisionKind, fresh, LIMITS, push, reminder } from "./ledger.ts";

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
	let pending: { kind: "decides" | "rejects"; text: string } | undefined;
	// set_next calls in the current run
	let setNextCalls = 0;
	pi.on("agent_start", async () => {
		setNextCalls = 0;
	});

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
					pending = undefined;
					break;
				case "add_rejected":
					state.rejected = push(state.rejected, text, LIMITS.rejected);
					pending = undefined;
					break;
				case "add_open":
					state.open = push(state.open, text, LIMITS.open);
					break;
				case "close_open": {
					const n = Number.parseInt(text, 10);
					if (!(n >= 1 && n <= state.open.length)) return reply(`Pass the number of an open item (1-${state.open.length}).`);
					state.open = state.open.filter((_, i) => i !== n - 1);
					break;
				}
			}
			save(ctx);
			return reply("Updated.");
		},
	});

	// Before every model call: the reminder goes right before the user's latest message. It is not stored in the session.
	// Not at the very end: after a tool result, a trailing "before ending your reply, call set_next" makes the model
	// call set_next again and again
	pi.on("context", async (event) => {
		const message = { role: "custom" as const, customType: "anchor", content: reminder(state, pending), display: false, timestamp: Date.now() };
		const messages = [...event.messages];
		const lastUser = messages.map((m) => (m as { role?: string }).role).lastIndexOf("user");
		messages.splice(lastUser >= 0 ? lastUser : 0, 0, message as (typeof messages)[number]);
		return { messages };
	});

	// A message you type that decides or rejects something is flagged until the AI records it
	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" as const };
		const kind = decisionKind(event.text);
		pending = kind ? { kind, text: event.text.trim() } : undefined;
		return { action: "continue" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		pending = undefined;
		// Restore the last state saved on this branch
		const last = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "anchor")
			.at(-1) as { data?: Partial<Anchor> } | undefined;
		state = fresh(last?.data);
		render(ctx);
		pi.events.emit("anchor:changed", { ...state });
	});

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
		description: "Record a decision. The AI re-reads it before every model call (/decided <decision>)",
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
