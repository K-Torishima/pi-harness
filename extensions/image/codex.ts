/**
 * Pure helpers for image: the codex exec command line, and reading its JSON events.
 * No pi imports, so tests can load it directly.
 */

/** The instruction codex gets. It runs in a read-only sandbox, so it can only answer and draw */
export function instruction(prompt: string, references: number): string {
	const lines = ["Use your image generation tool to make exactly one image for the request below."];
	if (references > 0) lines.push("Use the attached image(s) as the reference: edit them or follow their look, as the request says.");
	lines.push("Do not run commands or write files. When the image is done, reply with one short line describing it.", "", "Request:", prompt);
	return lines.join("\n");
}

/**
 * Arguments for `codex exec`. --ignore-user-config keeps the user's hooks, MCP servers, and profiles out of it;
 * the ChatGPT login still comes from codex's own auth
 */
export function codexArgs(prompt: string, references: string[] = []): string[] {
	const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only"];
	for (const ref of references) args.push("-i", ref);
	args.push("--", instruction(prompt, references.length));
	return args;
}

export type CodexRun = { threadId?: string; message?: string; error?: string };

/** Read codex's --json event lines: the thread id (generated images are saved under it), its last message, and any error */
export function readEvents(stdout: string): CodexRun {
	const run: CodexRun = {};
	for (const line of stdout.split("\n")) {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type === "thread.started" && typeof event.thread_id === "string") run.threadId = event.thread_id;
		else if (event?.type === "item.completed" && event.item?.type === "agent_message") run.message = String(event.item.text ?? "").trim();
		else if (event?.type === "error" || event?.type === "turn.failed") run.error = String(event.message ?? event.error?.message ?? "codex failed");
	}
	return run;
}
