/**
 * quiet-tools: fold tool output so your eyes stay on the reply
 *
 * - Results of read, bash, grep, find, and ls show only a line count, like "→ 42 lines"
 * - edit and write keep pi's own view, because you want to see what changed
 * - Failed results, and results you expand with Ctrl+O, are shown in full with pi's view
 * Only how tools are displayed changes; what they do stays the same.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const QUIET = new Set(["read", "bash", "grep", "find", "ls"]);

/** Count the lines of text in a result */
function lineCount(content: { type: string; text?: string }[]): number {
	const text = content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text as string)
		.join("\n")
		.trim();
	return text ? text.split("\n").length : 0;
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!QUIET.has(toolName) || !base?.renderResult) return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				if (options.expanded || options.isPartial || context.isError) {
					return renderResult(result, options, theme, context);
				}
				const n = lineCount(result.content as { type: string; text?: string }[]);
				const label = n > 0 ? `→ ${n} line${n === 1 ? "" : "s"} (Ctrl+O to expand)` : "→ no output";
				return new Text(theme.fg("dim", label), 0, 0);
			},
		};
	});
}
