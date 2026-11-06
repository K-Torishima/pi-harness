/**
 * image: lets the AI generate an image and shows it inline in the terminal
 *
 * - The image tool runs `codex exec` with codex's image generation, so it uses the ChatGPT subscription, not a paid API.
 *   Requires a Codex CLI login
 * - Reference images (paths) can be passed to edit them or follow their look
 * - The result shows the image in pi (Kitty / iTerm2 image support: Warp, Ghostty, kitty, WezTerm, iTerm2) and names the file
 *   codex saved under ~/.codex/generated_images/, so it can be copied into a project
 * - Esc stops a generation; one image usually takes a minute or two
 */

import { spawn } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, resizeImage } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codexArgs, readEvents } from "./codex.ts";

const TIMEOUT_MS = 5 * 60_000;
// What the model and the terminal get; the full-size file stays on disk
const SHOWN = { maxWidth: 1024, maxHeight: 1024 };

const ImageParams = Type.Object({
	prompt: Type.String({ description: "What to draw, in the user's words plus any detail they gave (style, size, text in the image)" }),
	references: Type.Optional(Type.Array(Type.String(), { description: "Paths of images to edit or to follow as a reference" })),
});

type Run = { code: number | null; timedOut: boolean; stdout: string; stderr: string };

function runCodex(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<Run> {
	return new Promise((done, fail) => {
		// stdin is closed: codex otherwise waits to read more prompt from it
		const child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, timeout: TIMEOUT_MS });
		let stdout = "";
		let stderr = "";
		// Decode as UTF-8 so a character split across two chunks stays whole
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
		child.on("error", fail);
		// The timeout kills it with SIGTERM; an abort from Esc comes back through "error" instead
		child.on("close", (code, killedBy) => done({ code, timedOut: killedBy === "SIGTERM" && !signal?.aborted, stdout, stderr }));
	});
}

/**
 * The PNG files codex saved for one thread, oldest first. codex's --json events do not name the file,
 * so this follows where codex keeps them (checked with codex-cli 0.166)
 */
async function savedImages(threadId: string): Promise<string[]> {
	const dir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images", threadId);
	const names = await readdir(dir).catch(() => [] as string[]);
	const found = await Promise.all(
		names.filter((n) => n.endsWith(".png")).map(async (n) => ({ file: join(dir, n), time: await stat(join(dir, n)).then((s) => s.mtimeMs, () => -1) })),
	);
	return found.filter(({ time }) => time >= 0).sort((a, b) => a.time - b.time).map(({ file }) => file);
}

/** Why a reference cannot be passed to codex, or undefined. codex skips a missing file without a word */
async function badReference(path: string): Promise<string | undefined> {
	if (path.includes(",")) return `${path}: codex may split image paths at commas; copy it to a name without one`;
	return access(path).then(
		() => undefined,
		() => `${path}: not found`,
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "image",
		label: "Image",
		description:
			"Generate an image (or edit one, with references) and show it to the user in the terminal. Takes a minute or two. The result names the saved file; copy it with bash if the user wants it in the project.",
		parameters: ImageParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { files: [] as string[] } });
			const references = (params.references ?? []).map((p) => (isAbsolute(p) ? p : resolve(ctx.cwd, p)));
			const bad = (await Promise.all(references.map(badReference))).filter(Boolean);
			if (bad.length > 0) return fail(`Reference images not usable: ${bad.join("; ")}`);
			onUpdate?.({ content: [{ type: "text", text: "Generating an image with codex…" }], details: { files: [] } });

			let run: Run;
			try {
				run = await runCodex(codexArgs(params.prompt, references), ctx.cwd, signal);
			} catch (error) {
				const message = (error as Error).name === "AbortError" ? "Stopped." : `Could not run codex: ${(error as Error).message}. Is the Codex CLI installed and logged in?`;
				return fail(message);
			}
			const events = readEvents(run.stdout);
			const files = events.threadId ? await savedImages(events.threadId) : [];
			if (files.length === 0) {
				const why = run.timedOut
					? `codex did not finish within ${TIMEOUT_MS / 60_000} minutes`
					: events.failure || events.message || events.notice || run.stderr.trim().split("\n").at(-1) || `codex exited with ${run.code}`;
				return fail(`No image was generated: ${why}`);
			}

			const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
				{ type: "text", text: `Saved: ${files.join(", ")}${events.message ? `\n${events.message}` : ""}` },
			];
			for (const file of files) {
				// Only a resized copy is sent: null means pi could not bring it under its size limit, and the full file may be megabytes
				const shown = await readFile(file)
					.then((bytes) => resizeImage(bytes, "image/png", SHOWN))
					.catch(() => null);
				if (shown) content.push({ type: "image", data: shown.data, mimeType: shown.mimeType });
				else content.push({ type: "text", text: `${file} could not be shown here; open the file to see it.` });
			}
			return { content, details: { files } };
		},
	});
}
