/**
 * mandate: let the AI act only on what the user actually asked for, and stop asking about what they already did
 *
 * Overreach (building when asked to look, pushing when asked to commit) and over-asking
 * ("shall I proceed?" after a clear go-ahead) come from the same gap: the AI does not know what it is allowed to do.
 * mandate keeps that as state and enforces it on every tool call.
 *
 * - Mode for the current request: look (read and answer) / plan (read and propose) / do (change local files)
 *   Every new message you type starts in look. The AI moves to do by quoting your words with the mandate tool;
 *   a quote that is not in your latest message is rejected, so it cannot talk itself into do
 * - Outward actions (git push, PR / issue writes, deploys, API writes) need a grant: push / pr / issue / deploy / api.
 *   Grants last for the session, so you are not asked again
 * - In look / plan, edits, writes, and changing commands are blocked. Outward actions without a grant are blocked in every mode
 * - In do, a reply that ends by asking permission to go on gets sent back once, to carry on instead
 * - /goal switches to do, quoting the goal
 *
 * You use /mode [look|plan|do], /allow <grant...>, /revoke [grant|all], and /mandate (show).
 * Commands you type yourself with ! are never blocked.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asksPermission, classifyTool, GRANTS, type Grant, MODES, type Mode, quoteMatches } from "./rules.ts";

type State = { mode: Mode; quote: string; grants: Grant[] };

const MandateParams = Type.Object({
	action: StringEnum(["set_mode", "grant"] as const),
	mode: Type.Optional(StringEnum(MODES as Mode[], { description: "For set_mode: look, plan, or do" })),
	grant: Type.Optional(StringEnum(GRANTS as Grant[], { description: "For grant: push, pr, issue, deploy, or api" })),
	quote: Type.Optional(
		Type.String({ description: "The user's own words from their latest message that ask for this, copied exactly. Required for set_mode plan/do and for grant" }),
	),
});

const MODE_MEANING: Record<Mode, string> = {
	look: "read and answer only; change nothing",
	plan: "read and propose a plan; change nothing",
	do: "change local files and run commands for this request",
};

type TextPart = { type?: string; text?: string };
const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? (content as TextPart[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n") : "";

/** The text of the user's latest message on the current branch (not on branches left with /tree) */
function latestUserText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch() as { type: string; message?: { role?: string; content?: unknown } }[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i].message;
		if (entries[i].type === "message" && m?.role === "user") return textOf(m.content);
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let state: State = { mode: "look", quote: "", grants: [] };
	// Per user request: whether mandate blocked something since the mode was last raised, and whether we already sent a reply back
	let blocked = false;
	let nudged = false;
	// A follow-up typed while the agent runs is a new request; reset when its run starts, not while the current one is still working
	let resetOnNextRun = false;
	let current: ExtensionContext | undefined;

	const render = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		const t = ctx.ui.theme;
		const color = state.mode === "do" ? "success" : state.mode === "plan" ? "accent" : "muted";
		const quote = state.quote ? t.fg("muted", ` 「${state.quote.length > 24 ? `${state.quote.slice(0, 24)}…` : state.quote}」`) : "";
		const grants = state.grants.length > 0 ? t.fg("muted", ` +${state.grants.join(",")}`) : "";
		ctx.ui.setStatus("mandate", `${t.fg(color, state.mode)}${quote}${grants}`);
	};

	const startRequest = (ctx: ExtensionContext | undefined) => {
		blocked = false;
		nudged = false;
		state.mode = "look";
		state.quote = "";
		render(ctx);
	};

	const save = (ctx: ExtensionContext) => {
		pi.appendEntry("mandate", { grants: state.grants });
		render(ctx);
	};

	const setMode = (ctx: ExtensionContext | undefined, mode: Mode, quote: string) => {
		state.mode = mode;
		state.quote = quote;
		render(ctx);
	};

	const addGrants = (ctx: ExtensionContext, grants: Grant[]) => {
		state.grants = GRANTS.filter((g) => state.grants.includes(g) || grants.includes(g));
		save(ctx);
	};

	pi.registerTool({
		name: "mandate",
		label: "Mandate",
		description:
			"Record what the user allowed for the current request. set_mode do (or plan) when the user's latest message asks you to change something (or to plan); grant push / pr / issue / deploy / api when it asks for that outward action. Always pass the user's own words as quote; a quote that is not in their latest message is rejected. set_mode look needs no quote.",
		parameters: MandateParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { ...state } });
			const quote = (params.quote ?? "").trim();
			const userText = latestUserText(ctx);
			const quoted = quoteMatches(quote, userText);

			if (params.action === "set_mode") {
				const mode = params.mode;
				if (!mode) return reply("Pass mode: look, plan, or do.");
				if (mode !== "look" && !quoted)
					return reply(
						`Rejected: the quote is not in the user's latest message. Quote their exact words that ask for this. If they did not ask for it, stay in ${state.mode} and ask them in one sentence.`,
					);
				setMode(ctx, mode, mode === "look" ? "" : quote);
				// Blocks from before the user's go-ahead no longer explain a question at the end
				if (mode === "do") blocked = false;
				return reply(`Mode is now ${mode} (${MODE_MEANING[mode]}).${mode === "do" ? " Do not ask for permission inside this request; carry on and report." : ""}`);
			}

			const grant = params.grant;
			if (!grant) return reply("Pass grant: push, pr, issue, deploy, or api.");
			if (!quoted) return reply("Rejected: the quote is not in the user's latest message. Ask the user once, naming the exact action, then stop.");
			addGrants(ctx, [grant]);
			return reply(`Granted ${grant} for this session.`);
		},
	});

	// Before every request, tell the AI what it is allowed to do
	pi.on("before_agent_start", async () => {
		const lines = [
			`[mandate] Mode for this request: ${state.mode} (${MODE_MEANING[state.mode]})${state.quote ? ` — from the user's words "${state.quote}"` : ""}.`,
			`Outward actions allowed this session: ${state.grants.length > 0 ? state.grants.join(", ") : "none"}.`,
			"- If the user's latest message asks you to change, build, fix, or run something, call mandate set_mode do with their exact words as quote, then do it. Do not ask for permission first.",
			"- If it only asks a question, or asks you to look, check, or explain, stay in look and answer. Do not start changing things.",
			"- Outward actions (git push, PR or issue writes, deploys, API writes) need a grant. If the latest message asks for one, call mandate grant with their words; otherwise ask once, naming the exact action.",
			"- Inside the mode and grants you have, do not ask for permission. Carry on and report what you did.",
		];
		return { message: { customType: "mandate", content: lines.join("\n"), display: false } };
	});

	// A new message you type starts a new request, in look. Steering mid-run stays part of the current request
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.streamingBehavior === "steer") return { action: "continue" as const };
		if (event.streamingBehavior === "followUp") resetOnNextRun = true;
		else startRequest(ctx);
		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!resetOnNextRun) return;
		resetOnNextRun = false;
		startRequest(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const effect = classifyTool(event.toolName, event.input as Record<string, unknown>);
		if (effect.kind === "read") return undefined;

		let reason: string | undefined;
		if (effect.kind === "outward" && !state.grants.includes(effect.grant)) {
			reason = `"${effect.label}" is an outward action (${effect.grant}) the user has not allowed. If their latest message asks for it, call mandate grant ${effect.grant} with their exact words and retry; otherwise ask once, naming this exact action, and stop.`;
		} else if (state.mode !== "do") {
			reason = `This request is in ${state.mode} mode (${MODE_MEANING[state.mode]}), and "${effect.label}" changes things. If the user's latest message asks for a change, call mandate set_mode do with their exact words and retry; otherwise answer without changing anything.`;
		}
		if (!reason) return undefined;

		blocked = true;
		if (ctx.hasUI) ctx.ui.notify(`mandate: blocked ${effect.label} (${state.mode})`, "warning");
		return { block: true, reason: `Blocked by mandate: ${reason}` };
	});

	// In do, send a reply that ends by asking permission back once
	pi.on("agent_before_settle", async (event) => {
		if (state.mode !== "do" || nudged || blocked) return undefined;
		if (event.outcome === "aborted" || event.outcome === "error" || event.continue) return undefined;
		const last = [...event.context.contextMessages].reverse().find((m) => (m as { role?: string }).role === "assistant") as { content?: unknown } | undefined;
		if (!last || !asksPermission(textOf(last.content))) return undefined;
		nudged = true;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "mandate",
					content: `[mandate] You are in do mode for this request ("${state.quote}"), but your reply ends by asking for permission. If what you are asking about is part of this request and needs no outward grant, do it now and report. If it truly needs the user (a choice between options, or an outward action not granted), end with that one question.`,
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
		// Grants come from the current branch only, so a grant or /revoke on another branch does not leak in
		const last = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "mandate")
			.at(-1) as { data?: { grants?: Grant[] } } | undefined;
		state = { mode: "look", quote: "", grants: GRANTS.filter((g) => last?.data?.grants?.includes(g)) };
		resetOnNextRun = false;
		startRequest(ctx);
	});

	// A goal set with /goal is a request to do it
	pi.events.on("goal:start", (data) => {
		const objective = (data as { objective?: string }).objective ?? "";
		startRequest(current);
		setMode(current, "do", objective);
	});

	pi.registerCommand("mode", {
		description: "Set the mode for the current request (/mode look|plan|do)",
		handler: async (args, ctx) => {
			const mode = args.trim() as Mode;
			if (!MODES.includes(mode)) return ctx.ui.notify(`Mode: ${state.mode} (${MODE_MEANING[state.mode]}). Use /mode look|plan|do.`, "info");
			setMode(ctx, mode, mode === "look" ? "" : `/mode ${mode}`);
			ctx.ui.notify(`Mode set to ${mode}`, "info");
		},
	});

	pi.registerCommand("allow", {
		description: `Allow outward actions for this session (/allow ${GRANTS.join("|")} ...)`,
		handler: async (args, ctx) => {
			const asked = args.split(/[\s,]+/).filter(Boolean);
			const grants = asked.filter((a): a is Grant => (GRANTS as string[]).includes(a));
			if (grants.length === 0 || grants.length !== asked.length) return ctx.ui.notify(`Use /allow with any of: ${GRANTS.join(", ")}`, "info");
			addGrants(ctx, grants);
			ctx.ui.notify(`Allowed: ${state.grants.join(", ")}`, "info");
		},
	});

	pi.registerCommand("revoke", {
		description: "Take back outward grants (/revoke <grant> | /revoke all)",
		handler: async (args, ctx) => {
			const what = args.trim();
			if (what === "all") state.grants = [];
			else if ((GRANTS as string[]).includes(what)) state.grants = state.grants.filter((g) => g !== what);
			else return ctx.ui.notify(`Use /revoke <${GRANTS.join("|")}> or /revoke all`, "info");
			save(ctx);
			ctx.ui.notify(`Allowed now: ${state.grants.join(", ") || "none"}`, "info");
		},
	});

	pi.registerCommand("mandate", {
		description: "Show the current mode and outward grants",
		handler: async (_args, ctx) => {
			const lines = [
				`Mode: ${state.mode} (${MODE_MEANING[state.mode]})${state.quote ? ` — "${state.quote}"` : ""}`,
				`Outward grants: ${state.grants.join(", ") || "none"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
