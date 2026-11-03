/**
 * limits: show how much of the current provider's subscription quota is left, in pi's footer
 *
 * Each provider is read differently.
 * - OpenAI (ChatGPT plan): ask the Codex CLI app-server through its official "account/rateLimits/read" method.
 *   The usage endpoint refuses pi's own client name, so we ask Codex CLI itself. Tokens are never touched
 * - Anthropic (Claude plan): read the response headers pi received,
 *   anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}. Nothing shows until the first reply arrives
 *
 * The last known values are kept in ~/.pi/agent/pi-harness-limits.json and shown right after switching models.
 * Values older than 5 minutes are marked with how old they are.
 *
 * - Footer: "5h 88% left · wk 66% left" (numbers are examples). Turns yellow, then red, as it runs low
 * - /limits: remaining quota and reset times for every provider we know about
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One quota window. usedPercent is 0–100; resetsAt is in Unix seconds. */
type Window = { label: string; usedPercent: number; resetsAt?: number };
type Snapshot = { windows: Window[]; fetchedAt: number; plan?: string; note?: string };

const CACHE_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-harness-limits.json");
const OPENAI_REFRESH_MIN_MS = 30_000;
const STALE_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

const PROVIDER_NAMES: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude" };

// --- OpenAI: ask Codex CLI ---

type CodexWindow = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };
type CodexResult = {
	rateLimits: {
		primary?: CodexWindow | null;
		secondary?: CodexWindow | null;
		planType?: string | null;
	};
	rateLimitResetCredits?: { availableCount?: number } | null;
};

function codexLabel(w: CodexWindow): string {
	const mins = w.windowDurationMins ?? 0;
	if (mins === 10080) return "wk";
	if (mins > 0 && mins < 1440) return `${Math.round(mins / 60)}h`;
	if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
	return "quota";
}

/** Start the Codex CLI app-server, read the quota once, and shut it down. */
function readCodex(): Promise<Snapshot> {
	return new Promise((resolve, reject) => {
		const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			proc.kill();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("No response from Codex"))), TIMEOUT_MS);
		const send = (msg: object) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

		proc.on("error", (e) => finish(() => reject(e)));
		createInterface({ input: proc.stdout }).on("line", (line) => {
			let msg: { id?: number; result?: unknown; error?: { message?: string } };
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.id === 1) {
				send({ method: "initialized" });
				send({ id: 2, method: "account/rateLimits/read", params: null });
			} else if (msg.id === 2) {
				if (msg.error) {
					finish(() => reject(new Error(msg.error?.message ?? "Failed to read the quota")));
					return;
				}
				const r = msg.result as CodexResult;
				const windows = [r.rateLimits.primary, r.rateLimits.secondary]
					.filter((w): w is CodexWindow => !!w)
					.map((w) => ({ label: codexLabel(w), usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? undefined }));
				const credits = r.rateLimitResetCredits?.availableCount;
				finish(() =>
					resolve({
						windows,
						fetchedAt: Date.now(),
						plan: r.rateLimits.planType ?? undefined,
						note: credits ? `${credits} reset credit${credits === 1 ? "" : "s"}` : undefined,
					}),
				);
			}
		});
		send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi-harness", title: "pi harness", version: "0.1.0" } } });
	});
}

// --- Anthropic: read the response headers ---

/** Read the Claude plan quota from response headers. Undefined when the headers are absent. */
export function readAnthropicHeaders(headers: Record<string, string>): Snapshot | undefined {
	const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
	const windows: Window[] = [];
	for (const [key, label] of [
		["5h", "5h"],
		["7d", "wk"],
	] as const) {
		const util = h(`anthropic-ratelimit-unified-${key}-utilization`);
		if (util === undefined || util === "") continue;
		const n = Number(util);
		if (!Number.isFinite(n)) continue;
		// Arrives as a 0–1 ratio. Treat values above 1 as percentages, just in case
		const usedPercent = n <= 1 ? n * 100 : n;
		const reset = Number(h(`anthropic-ratelimit-unified-${key}-reset`));
		windows.push({ label, usedPercent, resetsAt: Number.isFinite(reset) && reset > 0 ? reset : undefined });
	}
	return windows.length > 0 ? { windows, fetchedAt: Date.now() } : undefined;
}

// --- Display ---

/** Turn the used percentage into the remaining percentage. */
const remaining = (w: Window) => Math.max(0, 100 - Math.round(w.usedPercent));

function resetLabel(w: Window): string {
	if (!w.resetsAt) return "unknown";
	const d = new Date(w.resetsAt * 1000);
	const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function ageLabel(fetchedAt: number): string {
	const mins = Math.round((Date.now() - fetchedAt) / 60_000);
	if (mins < 1) return "just now";
	return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
}

function loadCache(): Record<string, Snapshot> {
	try {
		return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, Snapshot>;
	} catch {
		return {};
	}
}

function saveCache(cache: Record<string, Snapshot>) {
	try {
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
	} catch {
		// Keep showing values even if they cannot be saved
	}
}

export default function (pi: ExtensionAPI) {
	const snapshots: Record<string, Snapshot> = loadCache();
	let openaiInFlight: Promise<void> | undefined;
	let staleTimer: ReturnType<typeof setInterval> | undefined;

	const store = (provider: string, snap: Snapshot) => {
		snapshots[provider] = snap;
		saveCache(snapshots);
	};

	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const t = ctx.ui.theme;
		const provider = ctx.model?.provider;
		const snap = provider ? snapshots[provider] : undefined;
		if (!provider || !(provider in PROVIDER_NAMES)) {
			ctx.ui.setStatus("limits", undefined);
			return;
		}
		if (!snap || snap.windows.length === 0) {
			ctx.ui.setStatus("limits", t.fg("dim", "quota shows after the first reply"));
			return;
		}
		const parts = snap.windows.map((w) => {
			const left = remaining(w);
			const color = left <= 10 ? "error" : left <= 30 ? "warning" : "muted";
			return t.fg(color, `${w.label} ${left}% left`);
		});
		const age = Date.now() - snap.fetchedAt > STALE_MS ? t.fg("dim", ` (${ageLabel(snap.fetchedAt)})`) : "";
		ctx.ui.setStatus("limits", parts.join(t.fg("muted", " · ")) + age);
	};

	const refreshOpenAI = (ctx: ExtensionContext, force = false): Promise<void> => {
		if (openaiInFlight) return openaiInFlight;
		const last = snapshots.openai;
		if (!force && last && Date.now() - last.fetchedAt < OPENAI_REFRESH_MIN_MS) return Promise.resolve();
		openaiInFlight = readCodex()
			.then((snap) => {
				store("openai", snap);
				render(ctx);
			})
			.catch(() => {})
			.finally(() => {
				openaiInFlight = undefined;
			});
		return openaiInFlight;
	};

	/** Refresh the current provider's values where we can. */
	const refreshCurrent = (ctx: ExtensionContext, force = false) => {
		render(ctx);
		if (ctx.model?.provider === "openai") void refreshOpenAI(ctx, force);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		refreshCurrent(ctx, true);
		// Redraw every minute so the "min ago" label keeps up
		if (staleTimer) clearInterval(staleTimer);
		staleTimer = setInterval(() => render(ctx), 60_000);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshCurrent(ctx, true);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		const snap = readAnthropicHeaders(event.headers ?? {});
		if (!snap) return;
		store("anthropic", snap);
		render(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		refreshCurrent(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (staleTimer) clearInterval(staleTimer);
	});

	pi.registerCommand("limits", {
		description: "Show remaining quota and reset times for each model provider",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider === "openai") await refreshOpenAI(ctx, true);
			const lines: string[] = [];
			for (const [provider, name] of Object.entries(PROVIDER_NAMES)) {
				const snap = snapshots[provider];
				const current = ctx.model?.provider === provider ? " (in use)" : "";
				if (!snap || snap.windows.length === 0) {
					lines.push(`${name}${current}: not known yet`);
					continue;
				}
				const extra = [snap.plan && `plan ${snap.plan}`, snap.note].filter(Boolean).join(" · ");
				lines.push(`${name}${current}: as of ${ageLabel(snap.fetchedAt)}${extra ? ` (${extra})` : ""}`);
				for (const w of snap.windows) lines.push(`  ${w.label}: ${remaining(w)}% left (resets ${resetLabel(w)})`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			render(ctx);
		},
	});
}
