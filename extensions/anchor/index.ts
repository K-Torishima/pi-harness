/**
 * anchor: pin the current focus, the next step, and what was decided, so neither you nor the AI drifts
 *
 * Where you are:
 * - Always show "◎ focus" and "▸ next step" above the editor
 * - Set the terminal tab title to the focus (so you can tell sessions apart when switching tabs)
 * AI drift:
 * - Before every request, have the AI re-read the focus, the decisions, and the rules to keep (so long chats and compaction do not wash them out)
 * - The AI rewrites the "next step" with the anchor tool at the end of every reply
 *
 * You use /focus <focus>, /decided <decision>, /now (show all), and /anchor clear.
 * A goal set with /goal becomes the focus automatically.
 * The state is saved in the session log, so it comes back when you reopen pi.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Anchor = { focus: string; next: string; decisions: string[] };

const EMPTY: Anchor = { focus: "", next: "", decisions: [] };
// Older decisions get pushed out, to keep the re-read short
const MAX_DECISIONS = 7;

// Only what every request must follow. Longer instructions belong in APPEND_SYSTEM.md
const RULES = [
	"Lead with the conclusion in the first sentence",
	"At most 3 key points, and one topic at a time",
	"Before starting work that drifts away from the focus, ask whether that is OK",
];

const AnchorParams = Type.Object({
	action: StringEnum(["set_next", "set_focus", "add_decision"] as const),
	text: Type.String({ description: "set_next: the next step, one sentence / set_focus: the current focus, one sentence / add_decision: something that was decided, one sentence" }),
});

export default function (pi: ExtensionAPI) {
	let state: Anchor = { ...EMPTY, decisions: [] };
	let current: ExtensionContext | undefined;

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
			"Update the \"current focus\", \"next step\", and \"decisions\" shown on the user's screen. Before ending a reply, use set_next to write the next step in one sentence. When something gets decided with the user, record it with add_decision. Use set_focus only when the user changes the focus.",
		parameters: AnchorParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = params.text.trim();
			if (!text) return { content: [{ type: "text" as const, text: "text is empty." }], details: {} };
			if (params.action === "set_next") state.next = text;
			else if (params.action === "set_focus") {
				if (text !== state.focus) state.next = "";
				state.focus = text;
			} else state.decisions = [...state.decisions, text].slice(-MAX_DECISIONS);
			save(ctx);
			return { content: [{ type: "text" as const, text: "Updated." }], details: { ...state } };
		},
	});

	// Before every request, have the AI re-read the focus, the decisions, and the rules
	pi.on("before_agent_start", async () => {
		const lines = ["[anchor] Re-read this before working on the request."];
		lines.push(`Current focus: ${state.focus || "(not set — infer it from the request and, if it is clear, set it with set_focus on the anchor tool)"}`);
		if (state.next) lines.push(`Next step decided last time: ${state.next}`);
		if (state.decisions.length > 0) lines.push("Decisions:", ...state.decisions.map((d) => `- ${d}`));
		lines.push("Rules to keep:", ...RULES.map((r) => `- ${r}`));
		lines.push("Before ending your reply, rewrite the next step in one sentence with set_next on the anchor tool.");
		return { message: { customType: "anchor", content: lines.join("\n"), display: false } };
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		// Restore the last state saved in the session log
		const last = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "anchor")
			.at(-1) as { data?: Anchor } | undefined;
		state = last?.data ? { ...EMPTY, ...last.data, decisions: [...(last.data.decisions ?? [])] } : { ...EMPTY, decisions: [] };
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
		description: "Record a decision. The AI re-reads it before every request (/decided <decision>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Write it as /decided <decision>.", "info");
			state.decisions = [...state.decisions, text].slice(-MAX_DECISIONS);
			save(ctx);
			ctx.ui.notify(`Added to decisions: ${text}`, "info");
		},
	});

	pi.registerCommand("now", {
		description: "Show the current focus, next step, and decisions",
		handler: async (_args, ctx) => {
			const lines = [
				`Focus: ${state.focus || "(none)"}`,
				`Next: ${state.next || "(none)"}`,
				...(state.decisions.length > 0 ? ["Decisions:", ...state.decisions.map((d, i) => `${i + 1}. ${d}`)] : []),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("anchor", {
		description: "Clear the anchor (/anchor clear)",
		handler: async (args, ctx) => {
			if (args.trim() !== "clear") return ctx.ui.notify("/anchor clear removes the focus, next step, and decisions.", "info");
			state = { ...EMPTY, decisions: [] };
			save(ctx);
			ctx.ui.notify("Anchor cleared", "info");
		},
	});
}
