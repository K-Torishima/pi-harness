/**
 * Collect the moments pi sessions went wrong between the user and the agent since the last run,
 * and write them to a local Markdown report. Run by launchd (make schedule-friction) or by hand.
 *
 *   node tools/friction/main.ts [--agent-dir <dir>] [--since <ISO time>] [--days <n>] [--no-notify]
 *
 * Without --since or --days it picks up where the last run stopped. A run with either one does not move that point,
 * so trying it by hand never makes the daily run skip anything.
 *
 * Reports quote the user's own sessions, so they stay in ~/.pi/agent/friction and are never committed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Incident, type Kind, readSession } from "./detect.ts";

const PER_KIND = 15;

const KINDS: { kind: Kind; title: string; hint: string }[] = [
	{ kind: "pushback", title: "Pushback", hint: "The user said the agent got it wrong or did something not asked for" },
	{ kind: "asked-again", title: "Asked again", hint: "The user repeated a request the agent had already been given" },
	{ kind: "status-check", title: "Status checks", hint: "The user had to ask where the work was" },
	{ kind: "interrupted", title: "Interrupted", hint: "The user stopped a run with Esc; their next message says why" },
	{ kind: "blocked-retry", title: "Blocked and retried", hint: "The agent ran into the same block more than once" },
	{ kind: "sent-back", title: "Sent back by the harness", hint: "reply, evidence, or mandate returned a reply" },
];

function args() {
	const a = process.argv.slice(2);
	const value = (name: string) => {
		const i = a.indexOf(name);
		return i >= 0 ? a[i + 1] : undefined;
	};
	// The same variable pi reads to find its agent directory
	const agentDir = value("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return { agentDir, since: value("--since"), days: value("--days"), notify: !a.includes("--no-notify") };
}

function readState(path: string): { lastRun?: string } {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

/** Sessions started from a temporary directory are test runs, not real work */
function isScratch(cwd: string): boolean {
	const roots = new Set(["/tmp/", "/private/tmp/", "/private/var/folders/"]);
	try {
		roots.add(`${realpathSync(tmpdir())}/`);
	} catch {
		// tmpdir is only a hint
	}
	return [...roots].some((r) => cwd.startsWith(r));
}

/** A short project name: the last two parts of the working directory */
const project = (cwd: string) => cwd.split("/").filter(Boolean).slice(-2).join("/") || "(unknown)";

function notify(text: string) {
	try {
		execFileSync("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "pi friction"`], { stdio: "ignore", timeout: 5000 });
	} catch {
		// A missing notification is not worth failing the run
	}
}

function render(since: string, now: string, found: { project: string; incident: Incident }[], turns: Map<string, number>): string {
	const out = [`# pi friction ${now.slice(0, 10)}`, "", `From ${since} to ${now}. ${found.length} moments in ${[...turns.values()].reduce((a, b) => a + b, 0)} user messages.`, ""];
	out.push("| Project | User messages | " + KINDS.map((k) => k.title).join(" | ") + " |");
	out.push("| --- | --- | " + KINDS.map(() => "---").join(" | ") + " |");
	for (const [name, count] of [...turns].sort((a, b) => b[1] - a[1])) {
		const row = KINDS.map((k) => found.filter((f) => f.project === name && f.incident.kind === k.kind).length);
		if (row.some((n) => n > 0) || count > 0) out.push(`| ${name} | ${count} | ${row.join(" | ")} |`);
	}
	for (const { kind, title, hint } of KINDS) {
		const items = found.filter((f) => f.incident.kind === kind);
		if (items.length === 0) continue;
		out.push("", `## ${title} (${items.length})`, "", hint, "");
		for (const { project: name, incident } of items.slice(-PER_KIND)) {
			out.push(`### ${name} · ${incident.time.slice(0, 16).replace("T", " ")}`, "");
			if (incident.before) out.push(`- Agent before: ${incident.before}`);
			out.push(`- ${kind === "blocked-retry" || kind === "sent-back" ? "Harness" : "User"}: ${incident.text}`, "");
		}
		if (items.length > PER_KIND) out.push(`(${items.length - PER_KIND} earlier ones not shown)`, "");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

/** Session files changed after `since`. No sessions directory yet means no sessions */
function sessionFiles(dir: string, since: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const sub of readdirSync(dir, { withFileTypes: true })) {
		if (!sub.isDirectory()) continue;
		for (const name of readdirSync(join(dir, sub.name))) {
			const file = join(dir, sub.name, name);
			if (name.endsWith(".jsonl") && statSync(file).mtime.toISOString() > since) files.push(file);
		}
	}
	return files;
}

function main() {
	const opts = args();
	const out = join(opts.agentDir, "friction");
	const state = join(out, "state.json");
	const now = new Date().toISOString();
	const manual = opts.since !== undefined || opts.days !== undefined;
	const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
	const since = opts.since ?? (opts.days ? daysAgo(Number(opts.days)) : (readState(state).lastRun ?? daysAgo(7)));
	const found: { project: string; incident: Incident }[] = [];
	const turns = new Map<string, number>();
	for (const file of sessionFiles(join(opts.agentDir, "sessions"), since)) {
		const report = readSession(readFileSync(file, "utf8").split("\n"), since);
		if (!report.cwd || isScratch(report.cwd)) continue;
		const p = project(report.cwd);
		turns.set(p, (turns.get(p) ?? 0) + report.userTurns);
		for (const incident of report.incidents) found.push({ project: p, incident });
	}
	found.sort((a, b) => a.incident.time.localeCompare(b.incident.time));
	mkdirSync(out, { recursive: true });
	const path = join(out, `${now.slice(0, 16).replace(/[T:]/g, "-")}.md`);
	writeFileSync(path, render(since, now, found, turns));
	if (!manual) writeFileSync(state, `${JSON.stringify({ lastRun: now })}\n`);
	console.log(`${found.length} moments → ${path}`);
	if (opts.notify && found.length > 0) notify(`${found.length} moments since the last run: ${basename(path)}`);
}

main();
