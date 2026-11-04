/**
 * Shared helpers for reading shell commands. Not an extension (no index.ts), so pi does not load it on its own.
 * Used by guard, mandate, secrets, and reviewed, so they all read a command the same way.
 */

/** Drop heredoc bodies, so text inside a script or message does not look like a command */
export function stripHeredocs(cmd: string): string {
	return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2");
}

// One left-to-right pass, so an apostrophe inside "it's" does not open a fake single-quoted span
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

/** Drop quoted strings, so `rg "rm -rf"` or `jq '.a > 1'` do not look like writes */
export function stripQuoted(cmd: string): string {
	return cmd.replace(QUOTED, (m) => (m[0] === "'" ? "''" : '""'));
}

/** Unwrap the script passed to `sh -c` / `bash -c` / `eval`, so the commands inside are read too */
export function unwrapShellC(cmd: string): string {
	return cmd.replace(/\b((?:ba|z)?sh\s+-l?c|eval)\s+('[^']*'|"(?:\\.|[^"\\])*")/g, (_m, lead: string, q: string) => `${lead} ; ${q.slice(1, -1)}`);
}

/** The command as it would run, with message text removed: heredocs dropped, sh -c unwrapped, quotes dropped */
export function commandText(cmd: string): string {
	return stripQuoted(unwrapShellC(stripHeredocs(cmd)));
}

/** Split a command line into simple commands at ; && || | newlines $( and backticks */
export function segments(cmd: string): string[] {
	return cmd
		.split(/;|&&|\|\||\||\n|\$\(|`/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** `git` plus its global options before the subcommand: -C <dir>, -c <key=value>, --no-pager, --git-dir=... */
export const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
