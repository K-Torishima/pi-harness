/**
 * voice: push-to-talk voice input for pi (in the spirit of Claude Code's voice mode)
 *
 * Hold the space bar to record; release it to transcribe into the editor.
 * Recording and recognition are done by the helper bin/pi-voice-helper (Apple's on-device speech recognition).
 * Build the helper with `make` at the repository root.
 *
 * - Detecting a long press: terminals do not report key releases, so spaces arriving
 *   in quick succession through key repeat count as "held down".
 *   When the repeats stop, the key counts as released.
 * - Press Esc while recording to cancel.
 *
 * Read aloud: /read speaks the last reply. Press Esc or run /read again to stop.
 * See read-aloud.ts for how it works.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReadAloud } from "./read-aloud";

// The helper lives in bin/ next to this file (see the README for building it).
// PI_VOICE_HELPER lets tests swap in a different helper.
const HELPER = process.env.PI_VOICE_HELPER ?? join(dirname(fileURLToPath(import.meta.url)), "bin", "pi-voice-helper");

/** Read macOS key repeat settings (in units of 15 ms). Falls back to the macOS defaults. */
function readKeyRepeat(key: string, fallback: number): number {
	try {
		const out = execFileSync("defaults", ["read", "-g", key], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const n = Number(out.trim());
		return Number.isFinite(n) && n > 0 ? n * 15 : fallback;
	} catch {
		return fallback;
	}
}
const KEY_REPEAT_MS = readKeyRepeat("KeyRepeat", 30);
const INITIAL_REPEAT_MS = readKeyRepeat("InitialKeyRepeat", 225);

/** Spaces closer together than this are key repeats (a long press). */
const REPEAT_GAP_MS = Math.max(100, KEY_REPEAT_MS * 3);
/** Spaces arriving before key repeat kicks in still count as part of the long press. */
const INITIAL_GAP_MS = INITIAL_REPEAT_MS + 150;
/** Number of repeats needed before we decide it is a long press. */
const REPEATS_TO_START = 2;
/** If repeats stop for this long, the key counts as released (stretched when the real repeat rate is slow). */
const MIN_RELEASE_MS = Math.max(250, KEY_REPEAT_MS * 6);

const isSpace = (data: string) => data === " " || data === "　";

type State = "idle" | "recording" | "finishing";

export default function (pi: ExtensionAPI) {
	const reader = new ReadAloud();
	/** Stops reading aloud and returns true if it was reading (filled in by the read-aloud part below). */
	let stopReadingHook: (ctx: ExtensionContext) => boolean = () => false;

	let state: State = "idle";
	let child: ChildProcessWithoutNullStreams | undefined;
	let lastSpaceAt = 0;
	let passedSpaces = 0; // spaces let through to the editor before the long press was detected
	let heldSpaces = 0; // spaces held back while deciding
	let repeatGaps: number[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let releaseTimer: ReturnType<typeof setInterval> | undefined;
	let partial = "";

	const showWidget = (ctx: ExtensionContext) => {
		const t = ctx.ui.theme;
		if (state === "idle") {
			ctx.ui.setWidget("voice", undefined);
			return;
		}
		const head =
			state === "recording"
				? `${t.fg("error", "●")} ${t.fg("text", "Listening")}${t.fg("dim", " (release to insert · Esc to cancel)")}`
				: `${t.fg("accent", "…")} ${t.fg("text", "Transcribing")}`;
		const lines = [head];
		if (partial) lines.push(`  ${t.fg("muted", partial)}`);
		ctx.ui.setWidget("voice", lines);
	};

	const reset = (ctx: ExtensionContext) => {
		state = "idle";
		child = undefined;
		partial = "";
		repeatGaps = [];
		if (releaseTimer) clearInterval(releaseTimer);
		releaseTimer = undefined;
		showWidget(ctx);
	};

	const releaseMs = () => {
		if (repeatGaps.length === 0) return MIN_RELEASE_MS;
		const avg = repeatGaps.reduce((a, b) => a + b, 0) / repeatGaps.length;
		return Math.max(MIN_RELEASE_MS, avg * 4);
	};

	const start = (ctx: ExtensionContext) => {
		if (!existsSync(HELPER)) {
			ctx.ui.notify(`Voice helper not found: ${HELPER}`, "error");
			return;
		}
		// Remove the spaces that slipped into the editor at the start of the long press
		if (passedSpaces > 0) {
			let text = ctx.ui.getEditorText();
			let removed = 0;
			while (removed < passedSpaces && text.length > 0 && isSpace(text.slice(-1))) {
				text = text.slice(0, -1);
				removed++;
			}
			if (removed > 0) ctx.ui.setEditorText(text);
		}
		passedSpaces = 0;
		heldSpaces = 0;

		// Starting to speak stops any reading aloud
		stopReadingHook(ctx);
		state = "recording";
		partial = "";
		showWidget(ctx);

		const proc = spawn(HELPER, [], { stdio: ["pipe", "pipe", "pipe"] });
		child = proc;
		const lines = createInterface({ input: proc.stdout });
		lines.on("line", (line) => {
			if (child !== proc) return;
			let msg: { type: string; text?: string; message?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type === "partial") {
				partial = msg.text ?? "";
				showWidget(ctx);
			} else if (msg.type === "final") {
				const text = (msg.text ?? "").trim();
				if (text) ctx.ui.pasteToEditor(text);
				reset(ctx);
			} else if (msg.type === "error") {
				ctx.ui.notify(`Voice input: ${msg.message ?? "failed"}`, "error");
				reset(ctx);
			}
		});
		proc.on("error", (err) => {
			if (child !== proc) return;
			ctx.ui.notify(`Could not start voice input: ${err.message}`, "error");
			reset(ctx);
		});
		proc.on("exit", () => {
			if (child === proc && state !== "idle") reset(ctx);
		});

		// When repeats stop, treat the key as released
		releaseTimer = setInterval(() => {
			if (state === "recording" && Date.now() - lastSpaceAt > releaseMs()) stop(ctx);
		}, 50);
	};

	const stop = (ctx: ExtensionContext) => {
		if (state !== "recording" || !child) return;
		state = "finishing";
		if (releaseTimer) clearInterval(releaseTimer);
		releaseTimer = undefined;
		showWidget(ctx);
		child.stdin.write("stop\n");
	};

	const cancel = (ctx: ExtensionContext) => {
		if (child) {
			child.stdin.write("cancel\n");
			child.kill();
		}
		reset(ctx);
		ctx.ui.notify("Voice input cancelled", "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.onTerminalInput((data) => {
			const now = Date.now();

			if (state !== "idle") {
				if (isSpace(data)) {
					if (state === "recording") {
						repeatGaps.push(now - lastSpaceAt);
						if (repeatGaps.length > 20) repeatGaps.shift();
					}
					lastSpaceAt = now;
					return { consume: true };
				}
				if (data === "\x1b") {
					cancel(ctx);
					return { consume: true };
				}
				return undefined;
			}

			// While reading aloud, Esc only stops the reading
			if (data === "\x1b" && stopReadingHook(ctx)) return { consume: true };

			if (!isSpace(data)) {
				// Put back any spaces held while deciding, in front of this character
				const held = heldSpaces;
				heldSpaces = 0;
				passedSpaces = 0;
				lastSpaceAt = 0;
				if (flushTimer) clearTimeout(flushTimer);
				return held > 0 ? { data: " ".repeat(held) + data } : undefined;
			}

			const gap = now - lastSpaceAt;
			lastSpaceAt = now;
			if (gap >= REPEAT_GAP_MS) {
				// A normal space. It might be the start of a long press, so count it
				if (heldSpaces > 0) {
					// The spaces held earlier were not a long press after all
					ctx.ui.pasteToEditor(" ".repeat(heldSpaces));
					heldSpaces = 0;
				}
				passedSpaces = gap < INITIAL_GAP_MS ? passedSpaces + 1 : 1;
				return undefined;
			}

			// A space delivered by key repeat
			heldSpaces++;
			if (flushTimer) clearTimeout(flushTimer);
			if (heldSpaces >= REPEATS_TO_START) {
				start(ctx);
				return { consume: true };
			}
			// If no more repeats arrive, return the held spaces to the editor
			flushTimer = setTimeout(() => {
				if (state === "idle" && heldSpaces > 0) {
					ctx.ui.pasteToEditor(" ".repeat(heldSpaces));
					heldSpaces = 0;
				}
			}, 250);
			return { consume: true };
		});
	});

	// --- Read aloud: /read speaks the last reply. Run /read again or press Esc to stop ---

	const lastAssistantText = (ctx: ExtensionContext): string => {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
			if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
			const text = e.message.content
				.filter((c: { type?: string }) => c.type === "text")
				.map((c: { text?: string }) => c.text ?? "")
				.join("\n")
				.trim();
			if (text) return text;
		}
		return "";
	};

	const showReading = (ctx: ExtensionContext) => {
		const t = ctx.ui.theme;
		ctx.ui.setWidget(
			"voice-read",
			reader.reading ? [`${t.fg("accent", "♪")} ${t.fg("text", "Reading aloud")}${t.fg("dim", " (Esc or /read to stop)")}`] : undefined,
		);
	};

	stopReadingHook = (ctx) => {
		if (!reader.reading) return false;
		reader.stop();
		showReading(ctx);
		return true;
	};

	pi.registerCommand("read", {
		description: "Read the last reply aloud (stops if already reading)",
		handler: async (_args, ctx) => {
			if (reader.reading) {
				reader.stop();
				showReading(ctx);
				return;
			}
			const text = lastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("There is no reply to read yet", "info");
				return;
			}
			// Return without waiting for the reading to finish so pi stays usable
			void reader
				.read(text, (message) => ctx.ui.notify(`Read aloud: ${message}`, "error"))
				.catch(() => {})
				.finally(() => showReading(ctx));
			showReading(ctx);
		},
	});

	pi.on("session_shutdown", async () => {
		reader.dispose();
		if (child) {
			child.stdin.write("cancel\n");
			child.kill();
		}
		child = undefined;
		if (releaseTimer) clearInterval(releaseTimer);
		if (flushTimer) clearTimeout(flushTimer);
	});
}
