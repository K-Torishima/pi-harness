/**
 * Collect the moments pi sessions went wrong between the user and the agent since the last run,
 * and write them to a local Markdown report. Run by launchd (make schedule-friction) or by hand.
 *
 *   node tools/friction/main.ts [--since <ISO time>] [--days <n>] [--no-notify]
 *
 * Reports quote the user's own sessions, so they stay in ~/.pi/agent/friction and are never committed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Incident, type Kind, readSession } from "./detect.ts";

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS = join(AGENT_DIR, "sessions");
const OUT = join(AGENT_DIR, "friction");
const STATE = join(OUT, "state.json");
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
	return { since: value("--since"), days: value("--days"), notify: !a.includes("--no-notify") };
}

function readState(): { lastRun?: string } {
	try {
		return JSON.parse(readFileSync(STATE, "utf8"));
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

function main() {
	const opts = args();
	const now = new Date().toISOString();
	const fallback = new Date(Date.now() - Number(opts.days ?? 7) * 86_400_000).toISOString();
	const since = opts.since ?? (opts.days ? fallback : (readState().lastRun ?? fallback));
	const found: { project: string; incident: Incident }[] = [];
	const turns = new Map<string, number>();
	for (const dir of readdirSync(SESSIONS, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		for (const name of readdirSync(join(SESSIONS, dir.name))) {
			const file = join(SESSIONS, dir.name, name);
			if (!name.endsWith(".jsonl") || statSync(file).mtime.toISOString() <= since) continue;
			const report = readSession(readFileSync(file, "utf8").split("\n"), since);
			if (!report.cwd || isScratch(report.cwd)) continue;
			const p = project(report.cwd);
			turns.set(p, (turns.get(p) ?? 0) + report.userTurns);
			for (const incident of report.incidents) found.push({ project: p, incident });
		}
	}
	found.sort((a, b) => a.incident.time.localeCompare(b.incident.time));
	mkdirSync(OUT, { recursive: true });
	const path = join(OUT, `${now.slice(0, 16).replace(/[T:]/g, "-")}.md`);
	writeFileSync(path, render(since, now, found, turns));
	writeFileSync(STATE, `${JSON.stringify({ lastRun: now })}\n`);
	console.log(`${found.length} moments → ${path}`);
	if (opts.notify && found.length > 0) notify(`${found.length} moments since the last run: ${basename(path)}`);
}

main();
