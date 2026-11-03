/**
 * lens: draw one lens card to pick up insights that lie outside your daily tools
 *
 * - Each time a session starts, draw one card from lenses.json and show it below the editor (avoiding last time's card)
 * - Hand the same card to the AI; only when it truly applies does the AI add one "Lens:" line at the end of its reply
 * - `/lens` draws again, `/lens add <name>: <question>` adds a card, `/lens list` shows the deck
 *
 * The last card drawn is kept in ~/.pi/agent/pi-harness-lens.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Lens = { name: string; question: string };

const DECK_FILE = join(dirname(fileURLToPath(import.meta.url)), "lenses.json");
const LAST_FILE = join(homedir(), ".pi", "agent", "pi-harness-lens.json");

function loadDeck(): { comment: string; lenses: Lens[] } {
	try {
		const raw = JSON.parse(readFileSync(DECK_FILE, "utf8")) as { $comment?: string; lenses?: Lens[] };
		return { comment: raw.$comment ?? "", lenses: (raw.lenses ?? []).filter((l) => l.name && l.question) };
	} catch {
		return { comment: "", lenses: [] };
	}
}

function lastName(): string {
	try {
		return (JSON.parse(readFileSync(LAST_FILE, "utf8")) as { last?: string }).last ?? "";
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let current: Lens | undefined;

	const draw = (ctx: ExtensionContext) => {
		const { lenses } = loadDeck();
		if (lenses.length === 0) {
			current = undefined;
		} else {
			// Avoid last time's card when there are others to choose from
			const prev = current?.name ?? lastName();
			const pool = lenses.length > 1 ? lenses.filter((l) => l.name !== prev) : lenses;
			current = pool[Math.floor(Math.random() * pool.length)];
			try {
				writeFileSync(LAST_FILE, JSON.stringify({ last: current.name }));
			} catch {
				// The card still works even if it cannot be remembered
			}
		}
		if (!ctx.hasUI) return;
		if (!current) return ctx.ui.setWidget("lens", undefined);
		const t = ctx.ui.theme;
		ctx.ui.setWidget("lens", [`${t.fg("accent", "✦")} ${t.fg("muted", `lens ${current.name} —`)} ${t.fg("dim", current.question)}`], { placement: "belowEditor" });
	};

	pi.on("session_start", async (_event, ctx) => draw(ctx));

	// Hand the same card to the AI. When it does not apply, nothing is added
	pi.on("before_agent_start", async () => {
		if (!current) return undefined;
		const content = [
			`[lens] Today's card: ${current.name} — ${current.question}`,
			'Only when this lens truly applies to what your reply is about, add one line starting with "Lens: " at the end of your reply. If it does not apply, add nothing.',
		].join("\n");
		return { message: { customType: "lens", content, display: false } };
	});

	pi.registerCommand("lens", {
		description: "Draw another lens card (/lens · /lens add <name>: <question> · /lens list)",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (text === "list") {
				const { lenses } = loadDeck();
				return ctx.ui.notify(lenses.map((l) => `${l.name === current?.name ? "● " : "  "}${l.name} — ${l.question}`).join("\n") || "The deck is empty.", "info");
			}

			if (text.startsWith("add")) {
				const m = text.slice(3).trim().match(/^([^:：]+)[:：]\s*(.+)$/);
				if (!m) return ctx.ui.notify("Write it as /lens add <name>: <question>.", "info");
				const deck = loadDeck();
				const lens = { name: m[1].trim(), question: m[2].trim() };
				if (deck.lenses.some((l) => l.name === lens.name)) return ctx.ui.notify(`"${lens.name}" is already in the deck.`, "warning");
				writeFileSync(DECK_FILE, `${JSON.stringify({ $comment: deck.comment, lenses: [...deck.lenses, lens] }, null, "\t")}\n`);
				return ctx.ui.notify(`Added a card: ${lens.name} — ${lens.question}`, "info");
			}

			draw(ctx);
			ctx.ui.notify(current ? `Drew: ${current.name} — ${current.question}` : "The deck is empty.", "info");
		},
	});
}
