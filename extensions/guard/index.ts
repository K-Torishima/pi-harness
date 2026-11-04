/**
 * guard: block only the things the AI must never do
 *
 * Rules live in rules.json (only what is listed there is blocked; everything else goes through).
 * Personal rules that should stay out of git go in rules.local.json next to it (gitignored); both are merged.
 * - commands: regexes matched against the command string passed to bash
 * - paths: globs matched against the file a tool such as read / edit / write touches
 * Commands you type yourself with ! are never blocked. Run /reload after editing the rules.
 * /guard lists the current rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandText } from "../lib/shell.ts";

// unquoted: match only the command itself, not text inside quotes or heredocs (messages, search strings)
type CommandRule = { name: string; pattern: string; except?: string; unquoted?: boolean; reason: string };
type PathRule = { name: string; path: string; except?: string; tools: string[]; reason: string };
type Rules = { commands?: CommandRule[]; paths?: PathRule[] };

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_FILE = join(HERE, "rules.json");
const LOCAL_RULES_FILE = join(HERE, "rules.local.json");
const HOME = homedir();

const expandHome = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

/** Turn a glob into a regex. ** spans any depth, * stays within one segment, {a,b} matches either. */
function globToRegExp(glob: string): RegExp {
	const g = expandHome(glob);
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*" && g[i + 1] === "*") {
			if (g[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") re += "(?:";
		else if (c === "}") re += ")";
		else if (c === ",") re += "|";
		else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	// Make "dir/**" match the directory itself too
	re = re.replace(/\/\.\*$/, "(?:/.*)?");
	return new RegExp(`^${re}$`);
}

type Compiled = {
	commands: { rule: CommandRule; re: RegExp; except?: RegExp }[];
	paths: { rule: PathRule; re: RegExp; except?: RegExp }[];
};

/** Read a rules file. A missing local file is fine; a broken one is an error. */
function readRules(path: string, optional: boolean): Rules {
	if (optional && !existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as Rules;
}

export function load(): { compiled: Compiled; error?: string } {
	try {
		const shared = readRules(RULES_FILE, false);
		const local = readRules(LOCAL_RULES_FILE, true);
		const rules: Rules = {
			commands: [...(shared.commands ?? []), ...(local.commands ?? [])],
			paths: [...(shared.paths ?? []), ...(local.paths ?? [])],
		};
		return {
			compiled: {
				commands: (rules.commands ?? []).map((rule) => ({
					rule,
					re: new RegExp(rule.pattern),
					except: rule.except ? new RegExp(rule.except, "g") : undefined,
				})),
				paths: (rules.paths ?? []).map((rule) => ({
					rule,
					re: globToRegExp(rule.path),
					except: rule.except ? globToRegExp(rule.except) : undefined,
				})),
			},
		};
	} catch (e) {
		return { compiled: { commands: [], paths: [] }, error: (e as Error).message };
	}
}

/** The first rule a command string matches */
export function matchCommand(c: Compiled, command: string): CommandRule | undefined {
	const bare = commandText(command);
	for (const { rule, re, except } of c.commands) {
		const text = rule.unquoted ? bare : command;
		if (!re.test(text)) continue;
		// Block only if it still matches after removing the exceptions (such as .env.example templates)
		if (except && !re.test(text.replace(except, ""))) continue;
		return rule;
	}
	return undefined;
}

/** The first rule the path a tool touches matches */
export function matchPath(c: Compiled, tool: string, path: string): PathRule | undefined {
	for (const { rule, re, except } of c.paths) {
		if (!rule.tools.includes(tool)) continue;
		if (!re.test(path)) continue;
		if (except?.test(path)) continue;
		return rule;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let { compiled, error } = load();

	const block = (ctx: ExtensionContext, name: string, reason: string) => {
		if (ctx.hasUI) ctx.ui.notify(`Blocked (${name}): ${reason}`, "warning");
		return { block: true, reason: `Blocked by guard (${name}): ${reason}. Find another way, or ask the user to do it.` };
	};

	pi.on("session_start", async (_event, ctx) => {
		({ compiled, error } = load());
		if (error && ctx.hasUI) ctx.ui.notify(`guard: could not read the rules (${error})`, "error");
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = String(input.command ?? "");
			const rule = matchCommand(compiled, command);
			return rule ? block(ctx, rule.name, rule.reason) : undefined;
		}

		if (["read", "edit", "write", "grep", "find", "ls"].includes(event.toolName)) {
			const raw = typeof input.path === "string" && input.path ? input.path : ".";
			const path = resolve(ctx.cwd, expandHome(raw));
			const rule = matchPath(compiled, event.toolName, path);
			return rule ? block(ctx, rule.name, rule.reason) : undefined;
		}

		return undefined;
	});

	pi.registerCommand("guard", {
		description: "List what the AI is blocked from doing (rules.json and rules.local.json)",
		handler: async (_args, ctx) => {
			({ compiled, error } = load());
			if (error) {
				ctx.ui.notify(`Could not read the rules: ${error}`, "error");
				return;
			}
			const lines = [
				...compiled.commands.map(({ rule }) => `command ${rule.name}: ${rule.reason}`),
				...compiled.paths.map(({ rule }) => `path ${rule.name} (${rule.tools.join("/")}): ${rule.reason}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
