/**
 * Pure rules for evidence: what counts as looking, changing, and verifying, and which claims in a reply need them.
 * No pi imports, so tests can load it directly.
 */

import { segments } from "../lib/shell.ts";
import { classifyCommand } from "../mandate/rules.ts";

export type Step = "look" | "change" | "verify";

// Commands that check that something works: tests, builds, type checks, linters, running the thing
const VERIFY =
	/^(?:\w+=\S*\s+)*(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck|type-check|verify|e2e)\b|node\s+--test|vitest|jest|mocha|playwright|tsc\b|eslint|biome|prettier\s+--check|ruff|mypy|pyright|pytest|python3?\s+-m\s+(?:pytest|unittest)|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|swift\s+(?:build|test)|xcodebuild|gradle|\.\/gradlew|make\b|curl\b|pi\s+-p\b|deno\s+(?:test|check|lint))/;

/** What a tool call is, for the purpose of backing a claim */
export function stepOf(toolName: string, input: Record<string, unknown>): Step | undefined {
	if (toolName === "edit" || toolName === "write") return "change";
	if (["read", "grep", "find", "ls", "web_search", "web_fetch", "fetch"].includes(toolName)) return "look";
	if (toolName !== "bash") return undefined;
	const command = String(input.command ?? "");
	if (segments(command).some((s) => VERIFY.test(s))) return "verify";
	const effect = classifyCommand(command);
	if (effect.kind === "local") return "change";
	return "look";
}

// Claims that tests or a build passed. Only running them backs these up
const PASSES =
	/テスト(?:が|は|も|を)?(?:すべて|全て|全部)?(?:通|パス|成功|green)|ビルド(?:が|も)?(?:通|成功)|\b(?:tests? (?:now )?(?:pass|passed|are (?:passing|green))|all (?:tests|checks) pass|build (?:passes|succeeded))\b/i;
// Claims that something works or was checked. Running something, or looking at the result after the change, backs these up
const WORKS = /動作確認(?:済|しました|できました|が取れ)|検証(?:済|しました|できました)|動(?:きました|くことを確認|いています)|問題なく動|\b(?:verified|works now|it works)\b/i;

// A question for the user about facts, as opposed to a choice only they can make
const ASKS_FACT =
	/(?:教えて(?:ください|下さい|もらえ)|どこ(?:に|で|を)?(?:あり|置|ある)|どれ(?:です|が)|何(?:です|を使)|ありますか|URL|パス|ファイル名|リポジトリ名|(?:can|could) you (?:share|send|tell|point)|where (?:is|are|can)|which (?:file|repo|branch|url)|what is the (?:url|path|name))/i;

/** Does the end of the reply ask the user for a fact? */
export function asksForFact(reply: string): boolean {
	const tail = reply.trim().slice(-250);
	// A question mark, or a Japanese request ("教えてください。") that ends without one
	const asks = /[?？]/.test(tail) || /(?:教えて|共有して|送って|貼って)(?:ください|下さい|もらえますか)/.test(tail);
	return asks && ASKS_FACT.test(tail);
}

/** Does the reply claim that tests or a build passed, or that something works? */
export function claimsItWorks(reply: string): { kind: "passes" | "works"; text: string } | undefined {
	const passes = reply.match(PASSES)?.[0];
	if (passes) return { kind: "passes", text: passes };
	const works = reply.match(WORKS)?.[0];
	return works ? { kind: "works", text: works } : undefined;
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
