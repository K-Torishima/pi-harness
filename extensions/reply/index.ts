/**
 * reply: make the final reply fit its reader, and say when a long run is done
 *
 * Rules about reply shape written in prose kept being ignored, so the clear-cut ones are checked mechanically:
 * - Before pi settles, the final reply is checked: English to a Japanese writer, too long when no detail was asked for,
 *   issue / PR numbers with no title or link, "A or B?" with the options never spelled out, and a preamble first line
 * - If something is off, the reply is sent back once to be rewritten. The first version is dropped from the AI's context,
 *   so only the rewrite counts from then on (it stays on your screen)
 * - When a run took 30 seconds or more, macOS shows a notification with the first line of the reply,
 *   so you do not have to keep asking "is it done?"
 *
 * Thresholds live in shape.ts. /reply shows them.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { onRequestStart, textOf } from "../lib/request.ts";
import { checkReply, MAX_CHARS, MAX_LINES } from "./shape.ts";

// Runs at least this long end with a notification
const NOTIFY_AFTER_MS = 30_000;

type Msg = { role?: string; content?: unknown };

/** The text of the AI's latest reply on the current branch */
function latestReply(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch() as { type: string; message?: Msg }[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i].message;
		if (entries[i].type === "message" && m?.role === "assistant") return textOf(m.content);
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	// Per request: whether the reply was already sent back, and when the request started
	let sentBack = false;
	let startedAt = 0;
	// What the user typed last. A /goal kickoff or a skill expansion is not their own wording, so it does not replace it
	let typed = "";

	onRequestStart(pi, (text, source) => {
		sentBack = false;
		startedAt = Date.now();
		if (source !== "extension") typed = text;
	});

	pi.on("agent_before_settle", async (event) => {
		// Do not check event.context.canContinue here: it is false whenever the context ends with the assistant's reply,
		// and turns true only once the message below is added
		if (sentBack || event.outcome === "aborted" || event.outcome === "error" || event.continue) return undefined;
		const entries = event.context.contextEntries as { sourceEntry?: { id?: string; type?: string }; messages?: Msg[] }[];
		const last = [...entries].reverse().find((e) => e.sourceEntry?.type === "message" && e.messages?.some((m) => m.role === "assistant"));
		const id = last?.sourceEntry?.id;
		if (!id) return undefined;
		const replyText = (last?.messages ?? []).filter((m) => m.role === "assistant").map((m) => textOf(m.content)).join("\n");
		const problems = checkReply(replyText, typed);
		if (problems.length === 0) return undefined;

		sentBack = true;
		return {
			entries: [
				...event.entries,
				// Drop the first version from the AI's context, so the rewrite is the reply that counts
				{ type: "context_edit" as const, targetId: id, replacement: null },
				{
					type: "custom_message" as const,
					customType: "reply",
					content: [
						"[reply] Your last reply does not fit the reader yet. Rewrite it and send only the rewritten reply. Do not mention this note.",
						...problems.map((p) => `- ${p}`),
						"Your last reply was:",
						"<<<",
						replyText,
						">>>",
					].join("\n"),
					display: false,
				},
			],
			continue: true,
		};
	});

	// Tell the user a long run is done, without them having to ask
	pi.on("agent_settled", async (event, ctx) => {
		const took = startedAt > 0 ? Date.now() - startedAt : 0;
		startedAt = 0;
		if (event.aborted || took < NOTIFY_AFTER_MS || !ctx.hasUI || process.platform !== "darwin") return;
		const first = latestReply(ctx)
			.split("\n")
			.map((l) => l.replace(/[*_`#>]/g, "").trim())
			.find(Boolean);
		const body = (first ?? "Done").slice(0, 120);
		const title = `pi · ${basename(ctx.cwd)}`;
		execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {});
	});

	pi.registerCommand("reply", {
		description: "Show what reply checks in a finished reply",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					`Sent back once when: English to a Japanese writer; over ${MAX_CHARS} characters or ${MAX_LINES} lines without a request for detail;`,
					"#numbers with no title or link; A / B options never spelled out; a preamble first line.",
					`Runs of ${NOTIFY_AFTER_MS / 1000}s or more end with a macOS notification.`,
				].join("\n"),
				"info",
			);
		},
	});
}
