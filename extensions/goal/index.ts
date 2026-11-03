/**
 * goal: set a goal and pi keeps working on its own until it is done
 *
 * - Start with `/goal <goal>`. The AI first sets "done criteria" with the goal tool
 * - Each time a reply ends, check whether the goal is done; if not, ask it to continue (this is the loop)
 * - It stops when the AI calls the goal tool with done (with how each criterion was verified) or blocked (a human decision is needed)
 * - It also stops on Esc, on errors, and when the round limit is reached
 * - `/goal` shows the current state; `/goal stop` gives up the goal
 *
 * Keeping a process alive while you leave it alone for hours is out of scope; that belongs outside pi.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// How many times we ask it to continue. At the limit we stop and hand back to the human
const MAX_ROUNDS = 15;

type Goal = {
	objective: string;
	criteria: string[];
	round: number;
	status: "active" | "done" | "blocked" | "stopped";
	note?: string;
};

const GoalParams = Type.Object({
	action: StringEnum(["set_criteria", "done", "blocked"] as const),
	criteria: Type.Optional(Type.Array(Type.String(), { description: "For set_criteria: what has to be true for the goal to count as done. Up to 3, each one something you can verify yourself" })),
	evidence: Type.Optional(Type.String({ description: "For done: for each criterion, what you did to verify it holds" })),
	reason: Type.Optional(Type.String({ description: "For blocked: what the human needs to decide, or which permission is missing" })),
});

function kickoff(objective: string): string {
	return [
		`Goal: ${objective}`,
		"",
		"Keep working on your own until this goal is done. How to proceed:",
		"1. First, use set_criteria on the goal tool to define up to 3 done criteria. Make each one something you can verify yourself (tests pass, a command prints an expected result, and so on)",
		"2. Repeat: work, verify, fix — until the criteria hold",
		"3. Once every criterion is verified, call done on the goal tool and write how you verified each one",
		"4. If you need a human decision, permission, or information, do not guess. Call blocked on the goal tool with the reason and stop",
	].join("\n");
}

function nudge(goal: Goal): string {
	const criteria = goal.criteria.length > 0 ? goal.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") : "  (not set yet — define them first with set_criteria on the goal tool)";
	return [
		`[goal ${goal.round}/${MAX_ROUNDS}] The goal is not done yet: ${goal.objective}`,
		"Done criteria:",
		criteria,
		"Keep going. Once everything is verified call done on the goal tool; if a human decision is needed call blocked.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let goal: Goal | undefined;

	const showStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!goal || goal.status !== "active") {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		ctx.ui.setStatus("goal", ctx.ui.theme.fg("accent", `◎ goal ${goal.round}/${MAX_ROUNDS}`));
	};

	const finish = (ctx: ExtensionContext, status: Goal["status"], message: string, level: "info" | "warning" = "info") => {
		if (!goal) return;
		goal.status = status;
		goal.note = message;
		showStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Report progress on the goal set with /goal. Use set_criteria to define the done criteria, done to report the goal is complete (with how each criterion was verified), and blocked to report that a human decision is needed. pi keeps asking you to continue until you call done or blocked.",
		parameters: GoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { goal } });
			if (!goal || goal.status !== "active") return reply("There is no active goal.");

			if (params.action === "set_criteria") {
				const criteria = (params.criteria ?? []).map((c) => c.trim()).filter(Boolean);
				if (criteria.length === 0) return reply("The criteria are empty. Pass 1 to 3 done criteria.");
				goal.criteria = criteria.slice(0, 3);
				return reply(`Criteria set:\n${goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
			}

			if (params.action === "done") {
				if (goal.criteria.length === 0) return reply("No criteria yet. Set them with set_criteria, verify them, then call done.");
				const evidence = params.evidence?.trim();
				if (!evidence) return reply("The evidence is empty. For each criterion, write what you did to verify it holds.");
				finish(ctx, "done", `Goal achieved: ${goal.objective}`);
				return reply("Recorded the goal as achieved. Finish your reply with a short summary of the criteria and how you verified them.");
			}

			const reason = params.reason?.trim() || "no reason given";
			finish(ctx, "blocked", `Goal paused (needs a human decision): ${reason}`, "warning");
			return reply("Stopped. Ask the human exactly one question, with options, about what they need to decide, then end your reply.");
		},
	});

	// Right before pi settles after a reply, ask it to continue if the goal is not done
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!goal || goal.status !== "active") return undefined;
		if (event.outcome === "aborted") {
			finish(ctx, "stopped", "Stopped with Esc, so the goal was dropped too. Run /goal again to continue.", "warning");
			return undefined;
		}
		if (event.outcome === "error") {
			finish(ctx, "stopped", "Stopped on an error, so the goal was dropped too.", "warning");
			return undefined;
		}
		if (!event.context.canContinue) return undefined;
		if (goal.round >= MAX_ROUNDS) {
			finish(ctx, "stopped", `Asked it to continue ${MAX_ROUNDS} times without finishing, so it stopped.`, "warning");
			return undefined;
		}
		goal.round += 1;
		showStatus(ctx);
		return {
			entries: [{ type: "custom_message" as const, customType: "goal", content: nudge(goal), display: true }],
			continue: true,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		goal = undefined;
		showStatus(ctx);
	});

	pi.registerCommand("goal", {
		description: "Set a goal and keep going until it is done (/goal <goal> · /goal · /goal stop)",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (!text) {
				if (!goal) return ctx.ui.notify("No goal yet. Start one with /goal <goal>.", "info");
				const criteria = goal.criteria.length > 0 ? goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(no criteria yet)";
				const state = goal.status === "active" ? `in progress ${goal.round}/${MAX_ROUNDS}` : (goal.note ?? goal.status);
				return ctx.ui.notify(`Goal: ${goal.objective}\n${state}\n${criteria}`, "info");
			}

			if (text === "stop") {
				if (!goal || goal.status !== "active") return ctx.ui.notify("There is no active goal.", "info");
				return finish(ctx, "stopped", "Goal dropped.");
			}

			if (goal?.status === "active") ctx.ui.notify(`Replaced the previous goal (was: ${goal.objective})`, "warning");
			goal = { objective: text, criteria: [], round: 0, status: "active" };
			showStatus(ctx);
			// Let the anchor extension use it as the current focus
			pi.events.emit("goal:start", { objective: text });
			pi.sendUserMessage(kickoff(text), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
