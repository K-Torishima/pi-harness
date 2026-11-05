/**
 * evidence: a reply may only claim what was actually checked, and may only ask what could not be looked up
 *
 * Over the session, this keeps a tally of what the AI did: looked something up, changed something, or verified
 * something (tests, builds, type checks, linters, running the thing). Before pi settles, the final reply is sent back once per request when:
 * - it says tests pass or that something works, but nothing was run to check it after the last change
 * - it asks the user for a fact (where, which, the URL, the path) without having looked anything up in this request
 *
 * A run stays valid until the next change (including one made with !), so answering "did the tests pass?" in a later request
 * is fine. The tally lives until pi restarts or reloads. /evidence shows it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onRequestStart, textOf } from "../lib/request.ts";
import { checkClaims, emptyLedger, type Ledger, record, startRequest as nextRequest, stepsOf } from "./claims.ts";

type Msg = { role?: string; content?: unknown };

export default function (pi: ExtensionAPI) {
	let ledger: Ledger = emptyLedger();
	let sentBack = false;

	const startRequest = () => {
		nextRequest(ledger);
		sentBack = false;
	};

	pi.on("session_start", async () => {
		ledger = emptyLedger();
		sentBack = false;
	});
	onRequestStart(pi, () => startRequest());
	// Each /goal round ends in its own reply, so each one gets checked. The tally carries over: a check stays valid until the next change
	pi.on("message_start", async (event) => {
		const m = event.message as { role?: string; customType?: string };
		if (m.role === "custom" && m.customType === "goal") sentBack = false;
	});

	// A change the user makes with ! or !! counts too: an earlier run no longer backs a claim after it.
	// Edits in the user's own editor cannot be seen
	pi.on("user_bash", async (event) => {
		if (stepsOf("bash", { command: event.command }).includes("change")) record(ledger, "change");
		return undefined;
	});

	// Count what actually ran; a failed or blocked call proves nothing
	pi.on("tool_result", async (event) => {
		if (event.isError) return undefined;
		for (const step of stepsOf(event.toolName, (event.input ?? {}) as Record<string, unknown>)) record(ledger, step);
		return undefined;
	});

	pi.on("agent_before_settle", async (event) => {
		// Not event.context.canContinue: it is false whenever the context ends with the assistant's reply
		if (sentBack || event.outcome === "aborted" || event.outcome === "error" || event.continue) return undefined;
		const last = [...(event.context.contextMessages as Msg[])].reverse().find((m) => m.role === "assistant");
		const problems = checkClaims(textOf(last?.content), ledger);
		if (problems.length === 0) return undefined;
		sentBack = true;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "evidence",
					// Marks a send-back for tools that read the session log (tools/friction)
					details: { sentBack: true },
					content: ["[evidence] Before you finish, fix this in your reply. Do not mention this note.", ...problems.map((p) => `- ${p}`)].join("\n"),
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("evidence", {
		description: "Show what the AI looked up, changed, and verified in this session",
		handler: async (_args, ctx) => {
			const at = (n: number) => (n === 0 ? "never" : `step ${n}`);
			ctx.ui.notify(
				`This session: ${ledger.seq} steps (this request from step ${ledger.requestStart + 1}). Last lookup: ${at(ledger.lastLook)}. Last change: ${at(ledger.lastChange)}. Last check: ${at(ledger.lastVerify)}.`,
				"info",
			);
		},
	});
}
