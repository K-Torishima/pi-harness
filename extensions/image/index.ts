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
import { readdir, readFile, stat } from "node:fs/promises";
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

function runCodex(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done, fail) => {
		// stdin is closed: codex otherwise waits to read more prompt from it
		const child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, timeout: TIMEOUT_MS });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", fail);
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

/** The PNG files codex saved for one thread, oldest first */
async function savedImages(threadId: string): Promise<string[]> {
	const dir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images", threadId);
	const names = await readdir(dir).catch(() => [] as string[]);
	const files = names.filter((n) => n.endsWith(".png")).map((n) => join(dir, n));
	const times = await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs));
	return files.map((f, i) => ({ f, t: times[i] })).sort((a, b) => a.t - b.t).map(({ f }) => f);
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
			onUpdate?.({ content: [{ type: "text", text: "Generating an image with codex…" }], details: { files: [] } });

			let run: Awaited<ReturnType<typeof runCodex>>;
			try {
				run = await runCodex(codexArgs(params.prompt, references), ctx.cwd, signal);
			} catch (error) {
				const message = (error as Error).name === "AbortError" ? "Stopped." : `Could not run codex: ${(error as Error).message}. Is the Codex CLI installed and logged in?`;
				return fail(message);
			}
			const events = readEvents(run.stdout);
			const files = events.threadId ? await savedImages(events.threadId) : [];
			if (files.length === 0) {
				const why = events.error ?? events.message ?? (run.stderr.trim().split("\n").at(-1) || `codex exited with ${run.code}`);
				return fail(`No image was generated: ${why}`);
			}

			const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
				{ type: "text", text: `Saved: ${files.join(", ")}${events.message ? `\n${events.message}` : ""}` },
			];
			for (const file of files) {
				const bytes = await readFile(file);
				const shown = await resizeImage(bytes, "image/png", SHOWN).catch(() => null);
				content.push(shown ? { type: "image", data: shown.data, mimeType: shown.mimeType } : { type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
			}
			return { content, details: { files } };
		},
	});
}
