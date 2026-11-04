/**
 * Pure rules for evidence: what counts as looking, changing, and verifying, and which claims in a reply need them.
 * No pi imports, so tests can load it directly.
 */

import { commandText, segments } from "../lib/shell.ts";
import { changesCodeSegment, classifyCommand, localChanges } from "../mandate/rules.ts";

export type Step = "look" | "change" | "verify";

// Commands that check that something works: tests, builds, type checks, linters, and requests to a local server.
// Only make targets that check or build count; `make link` or `make clean` prove nothing
const VERIFY =
	/^(?:\w+=\S*\s+)*(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck|type-check|verify|e2e)\b|node\s+--test|vitest|jest|mocha|playwright|tsc\b|eslint|biome\s+(?:check|lint|ci)|prettier\s+--check|ruff\s+check|mypy|pyright|pytest|python3?\s+-m\s+(?:pytest|unittest)|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|swift\s+(?:build|test)|xcodebuild|gradle|\.\/gradlew|make(?:\s+-\S+)*\s*(?:$|(?:test|tests|check|lint|build|verify|ci|typecheck|all)\b)|curl\b.*\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])|pi\s+-p\b|deno\s+(?:test|check|lint))/;
// Checkers run in a mode that rewrites files: a change, not a check
const FIXES = /\s--fix\b|\s--write\b|^(?:\w+=\S*\s+)*(?:npx\s+)?(?:ruff\s+format|prettier\s+--write|gofmt\s+-w|black\b|biome\s+format)/;

/** What a tool call did, step by step in the order it ran. `npm test && sed -i ...` is a check, then a change */
export function stepsOf(toolName: string, input: Record<string, unknown>): Step[] {
	if (toolName === "edit" || toolName === "write") return ["change"];
	if (["read", "grep", "find", "ls", "web_search", "web_fetch", "fetch"].includes(toolName)) return ["look"];
	if (toolName !== "bash") return [];
	const command = String(input.command ?? "");
	const steps: Step[] = [];
	for (const seg of segments(commandText(command))) {
		if (FIXES.test(seg)) steps.push("change");
		else if (VERIFY.test(seg)) steps.push("verify");
		else if (localChanges(seg).some(({ segment }) => changesCodeSegment(segment))) steps.push("change");
	}
	if (steps.length > 0) return steps;
	// A command that neither checks nor changes, such as cat or git diff, is a lookup. git add / commit count as nothing
	return classifyCommand(command).kind === "local" ? [] : ["look"];
}

// Claims that tests or a build passed. Only running them backs these up
const PASSES =
	/テスト(?:が|は|も|を)?(?:すべて|全て|全部)?(?:通|パス|成功|green)|ビルド(?:が|も)?(?:通|成功)|\b(?:tests? (?:now )?(?:pass|passed|are (?:passing|green))|all (?:tests|checks) pass|build (?:passes|succeeded))\b/gi;
// Claims that something works or was checked. Running something, or looking at the result after the change, backs these up
const WORKS = /動作確認(?:済|しました|できました|が取れ)|検証(?:済|しました|できました)|動(?:きました|くことを確認|いています)|問題なく動|\b(?:verified|works now|it works)\b/gi;

// "通りませんでした", "通らない", "成功しなかった": the claim is denied right after it
const DENIED_AFTER = /^\S{0,3}?(?:ませ|ない|なかっ|ず[、。]|ずに)/;
// "not verified", "haven't verified", "tests don't pass": the claim is denied right before it
const DENIED_BEFORE = /\b(?:not|never|no|n't|un)\s*(?:yet\s+|been\s+|all\s+)?$/i;

/** The first match of `re` in the text that is not denied around it */
function affirmed(text: string, re: RegExp): string | undefined {
	for (const m of text.matchAll(re)) {
		const at = m.index ?? 0;
		const after = text.slice(at + m[0].length, at + m[0].length + 8);
		const before = text.slice(Math.max(0, at - 16), at);
		if (!DENIED_AFTER.test(after) && !DENIED_BEFORE.test(before)) return m[0];
	}
	return undefined;
}

/** Does the reply claim that tests or a build passed, or that something works? Denials do not count */
export function claimsItWorks(reply: string): { kind: "passes" | "works"; text: string } | undefined {
	const passes = affirmed(reply, PASSES);
	if (passes) return { kind: "passes", text: passes };
	const works = affirmed(reply, WORKS);
	return works ? { kind: "works", text: works } : undefined;
}

// A question about a fact the AI could look up, as opposed to a choice or "anything else?"
const ASKS_FACT =
	/(?:どこ(?:に|で|を)?(?:あり|置|ある)|何(?:です|を使)|URL|パス|ファイル名|リポジトリ名|ブランチ名|(?:can|could) you (?:share|send|tell|point)|where (?:is|are|can)|which (?:file|repo|branch|url)|what is the (?:url|path|name))/i;
// A sentence that asks: a question mark, or a Japanese request that ends without one
const ASKS = /[?？]\s*$|(?:教えて|共有して|送って|貼って)(?:ください|下さい|もらえますか)/;

/** Does one of the last sentences of the reply ask the user for a fact? Each sentence is judged on its own */
export function asksForFact(reply: string): boolean {
	const sentences = reply
		.trim()
		.slice(-300)
		.split(/(?<=[。！!？?])|\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	return sentences.some((s) => ASKS.test(s) && ASKS_FACT.test(s));
}

export type Ledger = { seq: number; lastLook: number; lastChange: number; lastVerify: number };

export const emptyLedger = (): Ledger => ({ seq: 0, lastLook: 0, lastChange: 0, lastVerify: 0 });

export function record(ledger: Ledger, step: Step): void {
	ledger.seq += 1;
	if (step === "look") ledger.lastLook = ledger.seq;
	else if (step === "change") ledger.lastChange = ledger.seq;
	else ledger.lastVerify = ledger.seq;
}

/** What is wrong with the reply given what was done during this request. Empty when it holds up */
export function checkClaims(reply: string, ledger: Ledger): string[] {
	const problems: string[] = [];
	const claim = claimsItWorks(reply);
	if (claim) {
		// The latest step that can back the claim: a run for "passes", a run or a look for "works"
		const backing = claim.kind === "passes" ? ledger.lastVerify : Math.max(ledger.lastVerify, ledger.lastLook);
		if (backing === 0 || backing < ledger.lastChange) {
			const what = claim.kind === "passes" ? "the test or build" : "the command, or a look at the result,";
			problems.push(
				ledger.lastChange > 0
					? `It says "${claim.text}", but nothing after the last change checks it. Run ${what} that shows it now and report what you saw. If you cannot, say plainly that it is not verified.`
					: `It says "${claim.text}", but nothing during this request checks it. Run ${what} that shows it now and report what you saw, or say plainly that it is not verified.`,
			);
		}
	}
	if (asksForFact(reply) && ledger.lastLook === 0 && ledger.lastVerify === 0) {
		problems.push(
			"It asks the user for a fact without having looked anything up. If the answer could be in the repo, its docs, git history, or the tools you have, look first and ask only what only the user can know.",
		);
	}
	return problems;
}
