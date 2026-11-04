/**
 * Load one extension through pi's own loader, with a fake context, so tests can fire its handlers directly.
 * Needs pi installed (PI_PACKAGE, or found through Homebrew).
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI =
	process.env.PI_PACKAGE ??
	join(execSync("brew --prefix pi-coding-agent", { encoding: "utf8" }).trim(), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");

type Handler = (event: unknown, ctx: unknown) => unknown;
export type Entry = { type: string; customType?: string; data?: unknown; message?: { role: string; content: unknown } };

export async function loadExtension(path: string, cwd: string) {
	const loader = await import(pathToFileURL(join(PI, "dist/core/extensions/loader.js")).href);
	const { createEventBus } = await import(pathToFileURL(join(PI, "dist/core/event-bus.js")).href);
	const bus = createEventBus();
	const runtime = loader.createExtensionRuntime();
	const appended: { customType: string; data: unknown }[] = [];
	runtime.appendEntry = (customType: string, data: unknown) => appended.push({ customType, data });
	const result = await loader.loadExtensions([path], cwd, bus, runtime);
	assert.deepEqual(result.errors, []);
	const ext = result.extensions[0];

	const entries: Entry[] = [];
	// Entries that live only on another branch (left with /tree): in getEntries, but not in getBranch
	const otherBranch: Entry[] = [];
	const notes: string[] = [];
	const status: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		sessionManager: { getEntries: () => [...entries, ...otherBranch], getBranch: () => entries },
		ui: {
			notify: (m: string) => notes.push(m),
			setStatus: (_k: string, s: string) => status.push(s),
			setTitle: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
		},
	};

	/** Run every handler for an event and return the last result */
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		let last: unknown;
		for (const h of (ext.handlers.get(name) ?? []) as Handler[]) last = await h({ type: name, ...event }, ctx);
		return last as Record<string, unknown> | undefined;
	};
	const bash = (command: string) => fire("tool_call", { toolName: "bash", toolCallId: "t", input: { command } });
	const command = (name: string, args: string) => ext.commands.get(name).handler(args, ctx);

	await fire("session_start", { reason: "startup" });
	return { ext, ctx, bus, fire, bash, command, appended, entries, otherBranch, notes, status };
}
