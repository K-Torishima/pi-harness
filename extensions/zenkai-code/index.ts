/**
 * zenkai-code: give pi the "ZENKAI CODE" look
 *
 * - Header: a big "ZENKAI CODE" logo, plus the working directory, branch, and model
 * - Editor: bronze rules above and below, with a gold "❯" prompt (in the style of Hermes Agent)
 * - Footer: a navy bar with the working directory, branch, model, other extensions' statuses, and context usage
 *
 * The fire gradient is only for the logo; the editor and footer use Hermes Agent's gold and bronze palette. Body text keeps the readable colors of themes/zenkai.json.
 * Run /zenkai-code to toggle back to pi's default look.
 */

import { execFileSync } from "node:child_process";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

// Logo glyphs. Each letter is drawn six rows tall
const GLYPHS: Record<string, string[]> = {
	Z: ["███████╗", "╚══███╔╝", "  ███╔╝ ", " ███╔╝  ", "███████╗", "╚══════╝"],
	E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
	N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
	K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
	A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
	I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
	C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
	O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
	D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
	" ": ["  ", "  ", "  ", "  ", "  ", "  "],
};

function banner(word: string): string[] {
	return GLYPHS.Z.map((_, row) => [...word].map((ch) => GLYPHS[ch][row]).join(""));
}

// One line on wide terminals, stacked in two rows on narrow ones
const LOGO_WIDE = banner("ZENKAI CODE");
const LOGO_STACKED = [...banner("ZENKAI"), ...banner("CODE")];

// Logo colors. To match "zenkai" (full throttle), burn from gold at the top left through orange and red to crimson at the bottom right
const STOPS: [number, number, number][] = [
	[0xff, 0xe0, 0x66],
	[0xff, 0x8a, 0x1f],
	[0xff, 0x2e, 0x3b],
	[0xd9, 0x1a, 0x8c],
];
// How long the logo flares up at startup (ms). Meanwhile the flames flicker, a shine sweeps across twice, and sparks rise
const INTRO_MS = 2400;
const SHINE_PASS_MS = 1200;
const FRAME_MS = 50;
const WHITE = [255, 255, 255];

function mix(a: number[], b: number[], t: number): number[] {
	return a.map((c, i) => c + (b[i] - c) * t);
}

/** The color at position t (0–1) along STOPS */
function colorAt(t: number): number[] {
	const x = Math.min(Math.max(t, 0), 1) * (STOPS.length - 1);
	const i = Math.min(Math.floor(x), STOPS.length - 2);
	return mix(STOPS[i], STOPS[i + 1], x - i);
}

/** A deterministic 0–1 pseudo-random value for a coordinate (the same spot always gets the same value) */
function hash(a: number, b: number): number {
	let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const rgb = ([r, g, b]: number[], ch: string) => `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${ch}`;

/**
 * Paint one logo line character by character with a diagonal gradient.
 * The higher heat (0–1) is, the more the colors flicker like flames; a white shine is laid over position shine (0–1, or null for none).
 */
function paintLogoLine(line: string, row: number, rows: number, elapsed: number, heat: number, shine: number | null): string {
	const chars = [...line];
	const span = chars.length + rows * 2;
	const frame = Math.floor(elapsed / FRAME_MS);
	let out = "";
	for (let x = 0; x < chars.length; x++) {
		const ch = chars[x];
		if (ch === " ") {
			out += ch;
			continue;
		}
		// Shift the color position over time so the flames seem to flow
		const wave = Math.sin(elapsed / 140 + row * 0.9 + x * 0.15) * 0.08 * heat;
		let color = colorAt((x + row * 2) / span + wave);
		// Flicker each character; brighter spots lean toward white
		const flick = (hash(x + row * 131, frame) - 0.5) * heat;
		color = flick > 0 ? mix(color, WHITE, flick * 0.9) : color.map((c) => c * (1 + flick * 0.8));
		if (shine !== null) {
			const d = Math.abs((x + row * 2) / span - shine);
			if (d < 0.12) color = mix(color, WHITE, (1 - d / 0.12) * 0.9);
		}
		out += rgb(color, ch);
	}
	return `${out}\x1b[39m`;
}

// Everything except the logo follows Hermes Agent's default palette (gold and bronze)
const HERMES = {
	bronze: "#CD7F32",
	gold: "#FFD700",
	amber: "#FFBF00",
	goldenrod: "#DAA520",
	dark: "#B8860B",
	cornsilk: "#FFF8DC",
	warn: "#FFA726",
	error: "#EF5350",
	bar: "#1A1A2E",
};

const hexRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");
const fg = (hex: string, text: string) => `\x1b[38;2;${hexRgb(hex)}m${text}\x1b[39m`;
const bgCode = (hex: string) => `\x1b[48;2;${hexRgb(hex)}m`;

const SPARKS = ["✦", "✧", "˙", "·", "*", "⋆"];

/** Draw rows of sparks above the logo. While flaring up they rise one row per frame */
function sparkLines(width: number, rows: number, elapsed: number, heat: number): string[] {
	const frame = Math.floor(Math.min(elapsed, INTRO_MS) / FRAME_MS);
	const density = 0.05 + 0.1 * heat;
	const lines: string[] = [];
	for (let r = 0; r < rows; r++) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const v = hash(x, r + frame);
			if (v < density) {
				// Dim the upper rows so the sparks seem to fade as they rise
				const fade = 0.35 + 0.65 * ((r + 1) / rows);
				const color = colorAt(hash(x, r + frame + 7) * 0.6).map((c) => c * fade);
				line += rgb(color, SPARKS[Math.floor((v / density) * SPARKS.length)]);
			} else line += " ";
		}
		lines.push(`${line}\x1b[39m`);
	}
	return lines;
}

/** The current branch name, or empty outside git */
function gitBranch(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const apply = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		// --- Header ---
		// Sparks and a big "ZENKAI CODE" logo on top (it flares up at startup), with the location and model below
		const branch = gitBranch(ctx.cwd);
		ctx.ui.setHeader((tui, theme) => {
			const started = Date.now();
			const timer = setInterval(() => {
				tui.requestRender();
				if (Date.now() - started > INTRO_MS) clearInterval(timer);
			}, FRAME_MS);
			return {
				dispose: () => clearInterval(timer),
				render(width: number): string[] {
					const elapsed = Date.now() - started;
					const burning = elapsed < INTRO_MS;
					// The flare is strongest at first and settles toward the end
					const heat = burning ? 1 - (elapsed / INTRO_MS) * 0.85 : 0;
					// The shine enters from outside the logo and exits on the other side, twice
					const shine = burning ? -0.2 + ((elapsed % SHINE_PASS_MS) / SHINE_PASS_MS) * 1.4 : null;
					const model = ctx.model?.id ?? "no model";
					const meta = [branch, model, pi.getThinkingLevel()].filter(Boolean).join(" · ");
					const info = [
						`${theme.fg("accent", "✻")} ${theme.bold("Welcome back")}  ${theme.fg("accent", formatCwd(ctx.cwd))}`,
						`  ${theme.fg("muted", meta)}`,
						`  ${theme.fg("dim", "/hotkeys for shortcuts · /model to switch model")}`,
					].map((l) => truncateToWidth(`  ${l}`, width, "…"));
					// Pick the logo that fits. If neither fits, show text only
					const logo = [LOGO_WIDE, LOGO_STACKED].find((l) => visibleWidth(l[0]) + 4 <= width);
					if (!logo) return ["", ...info, ""];
					const logoWidth = visibleWidth(logo[0]);
					const sparks = sparkLines(logoWidth, 2, elapsed, heat).map((l) => `  ${l}`);
					const rows = logo.map((line, i) => `  ${paintLogoLine(line, i, logo.length, elapsed, heat, shine)}`);
					return [...sparks, ...rows, "", ...info, ""];
				},
				invalidate() {},
			};
		});

		// --- Editor ---
		// Bronze rules above and below, and a gold ❯ in front. The content is drawn narrower by the width of ❯
		const LEFT = 2;
		class ZenkaiEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings);
			}

			render(width: number): string[] {
				if (width < 10) return super.render(width);
				const lines = super.render(width - LEFT);
				if (lines.length < 3) return lines;

				// In bash mode (input starting with !) use pi's colors so it stands out
				const bash = this.getText().trimStart().startsWith("!");
				const rule = (s: string) => {
					const plain = stripAnsi(s);
					const full = plain + "─".repeat(Math.max(0, width - visibleWidth(plain)));
					return bash ? this.borderColor(full) : fg(HERMES.bronze, full);
				};
				const prompt = `\x1b[1m${bash ? this.borderColor("❯") : fg(HERMES.gold, "❯")}\x1b[22m `;
				const acHeight = (this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight ?? 0;
				const bottom = lines.length - 1 - acHeight;
				if (bottom < 1) return lines;

				const out: string[] = [rule(lines[0])];
				for (let i = 1; i < bottom; i++) out.push(`${i === 1 ? prompt : "  "}${lines[i]}`);
				out.push(rule(lines[bottom]));
				// Indent autocomplete suggestions (such as the / command list) by the width of ❯
				for (let i = bottom + 1; i < lines.length; i++) out.push(`${" ".repeat(LEFT)}${lines[i]}`);
				return out;
			}

			handleMouse(event: { x: number; y: number; width: number; [k: string]: unknown }) {
				const base = (CustomEditor.prototype as unknown as { handleMouse?: (e: unknown) => unknown }).handleMouse;
				if (!base) return undefined;
				return base.call(this, { ...event, x: event.x - LEFT, width: event.width - LEFT });
			}
		}
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new ZenkaiEditor(tui, theme, keybindings));

		// --- Footer ---
		// Lay out the current state in gold text on a navy bar
		const BAR = bgCode(HERMES.bar);
		// Other extensions' statuses contain color resets that would cut the bar's background, so reapply it after every reset
		const onBar = (s: string) => `${BAR}${s.replaceAll("\x1b[0m", `\x1b[0m${BAR}`).replaceAll("\x1b[49m", BAR)}\x1b[0m`;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id ?? "no model";
					const thinking = pi.getThinkingLevel();
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					const p = usage?.percent ?? null;

					const sep = fg(HERMES.dark, " │ ");
					const leftItems = [fg(HERMES.cornsilk, formatCwd(ctx.cwd)), branch ? fg(HERMES.goldenrod, branch) : "", fg(HERMES.amber, `${model} · ${thinking}`)];
					const left = ` ${leftItems.filter(Boolean).join(sep)}`;
					// Show statuses other extensions set with setStatus (quota and so on) on the right
					const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
					// Context turns orange above 70% and red above 90%
					const pct = p !== null ? fg(p >= 90 ? HERMES.error : p >= 70 ? HERMES.warn : HERMES.dark, `ctx ${Math.round(p)}%`) : "";
					const items = [...statuses, pct].filter(Boolean);
					const right = items.length > 0 ? `${items.join(sep)} ` : "";
					const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const line = truncateToWidth(left + gap + right, width);
					const fill = " ".repeat(Math.max(0, width - visibleWidth(line)));
					return [onBar(line + fill)];
				},
			};
		});
	};

	const restore = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(undefined);
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) apply(ctx);
	});

	pi.registerCommand("zenkai-code", {
		description: "Toggle between the ZENKAI CODE look and pi's default look",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) apply(ctx);
			else restore(ctx);
			ctx.ui.notify(enabled ? "Switched to the ZENKAI CODE look" : "Back to pi's default look", "info");
		},
	});
}
