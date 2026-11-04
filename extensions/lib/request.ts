/**
 * Shared helpers for extensions that work per request. Not an extension (no index.ts), so pi does not load it on its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TextPart = { type?: string; text?: string };

/** The text of a message's content, whether it is a string or a list of parts */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as TextPart[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n");
}

/**
 * Call `onStart(text)` whenever a new request starts:
 * - a message typed while pi is idle, or one handed over by an extension (such as the /goal kickoff): right away
 * - a follow-up queued while pi is busy: when its own run starts, not while the current one is still working
 * Steering typed mid-run belongs to the current request and starts nothing.
 * `text` is what was typed (before skills and templates expand), or the extension's message.
 */
export function onRequestStart(pi: ExtensionAPI, onStart: (text: string, source: string) => void): void {
	let queued: { text: string; source: string } | undefined;
	pi.on("input", async (event) => {
		if (event.streamingBehavior === "steer") return { action: "continue" as const };
		if (event.streamingBehavior === "followUp") queued = { text: event.text, source: event.source };
		else onStart(event.text, event.source);
		return { action: "continue" as const };
	});
	pi.on("agent_start", async () => {
		if (!queued) return;
		const { text, source } = queued;
		queued = undefined;
		onStart(text, source);
	});
}
