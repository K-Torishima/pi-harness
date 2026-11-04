import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { asksForFact, checkClaims, claimsItWorks, emptyLedger, record, stepOf } from "./claims.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("stepOf sorts tool calls into look, change, and verify", () => {
	assert.equal(stepOf("read", { path: "a.ts" }), "look");
	assert.equal(stepOf("edit", { path: "a.ts" }), "change");
	assert.equal(stepOf("bash", { command: "rg foo src" }), "look");
	assert.equal(stepOf("bash", { command: "sed -i '' 's/a/b/' a.ts" }), "change");
	for (const c of ["make test", "npm test", "npm run lint", "pnpm build", "node --test 'x/**/*.test.ts'", "npx vitest run", "cd app && npx tsc --noEmit", "pytest -q", "go test ./...", "curl -s localhost:3000/health"])
		assert.equal(stepOf("bash", { command: c }), "verify", c);
	assert.equal(stepOf("anchor", { action: "set_next" }), undefined);
});

test("claims and fact questions are recognized", () => {
	assert.deepEqual(claimsItWorks("修正してテストも全部通りました。"), { kind: "passes", text: "テストも全部通" });
	assert.equal(claimsItWorks("Fixed it, and all tests pass now.")?.kind, "passes");
	assert.equal(claimsItWorks("動作確認済みです。")?.kind, "works");
	assert.equal(claimsItWorks("直しました。テストはまだ走らせていません。"), undefined);
	assert.ok(asksForFact("対象のリポジトリ名を教えてください。"));
	assert.ok(asksForFact("Where is the config file?"));
	assert.ok(!asksForFact("A と B のどちらにしますか？"), "a choice only the user can make is fine");
	assert.ok(!asksForFact("設定ファイルのパスを確認しました。"), "no question");
});

const ledger = (...steps: ("look" | "change" | "verify")[]) => {
	const l = emptyLedger();
	for (const s of steps) record(l, s);
	return l;
};

test("a 'tests pass' claim needs a check after the last change", () => {
	const reply = "直して、テストも通りました。";
	assert.match(checkClaims(reply, ledger("change"))[0], /after the last change/);
	assert.match(checkClaims(reply, ledger("change", "verify", "change"))[0], /after the last change/);
	assert.deepEqual(checkClaims(reply, ledger("change", "verify")), []);
	assert.match(checkClaims(reply, ledger("look"))[0], /during this request/);
	assert.deepEqual(checkClaims(reply, ledger("verify")), [], "checked without changing anything");
	assert.deepEqual(checkClaims("直しました。テストはまだです。", ledger("change")), []);
});

test("a 'works' claim can be backed by looking at the result after the change; a 'tests pass' claim cannot", () => {
	assert.deepEqual(checkClaims("書き換えて、動作確認済みです。", ledger("change", "look")), []);
	assert.match(checkClaims("書き換えて、動作確認済みです。", ledger("look", "change"))[0], /after the last change/);
	assert.match(checkClaims("書き換えて、テストも通りました。", ledger("change", "look"))[0], /the test or build/);
});

test("asking for a fact needs a lookup first", () => {
	const reply = "設定ファイルはどこにありますか？";
	assert.match(checkClaims(reply, ledger())[0], /without having looked/);
	assert.deepEqual(checkClaims(reply, ledger("look")), []);
});

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const ran = (toolName: string, input: Record<string, unknown>, isError = false) => m.fire("tool_result", { toolName, input, isError, content: [] });
	// The real shape right after the assistant's reply
	const settle = (reply: string) =>
		m.fire("agent_before_settle", { outcome: "completed", entries: [], continue: false, context: { canContinue: false, contextMessages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] } });
	await m.fire("input", { text: "バグを直して", source: "interactive" });
	return { ...m, ran, settle };
}

test("an unbacked claim is sent back once per request", async () => {
	const m = await setup();
	await m.ran("edit", { path: "a.ts" });
	await m.ran("bash", { command: "make test" }, true);
	const r = await m.settle("直して、テストも通りました。");
	assert.equal(r?.continue, true);
	assert.match(String((r?.entries as { content?: string }[])[0].content), /\[evidence\][\s\S]*after the last change/);
	assert.equal(await m.settle("直して、テストも通りました。"), undefined, "only once");
});

test("a backed claim passes, and a new request starts a new tally", async () => {
	const m = await setup();
	await m.ran("edit", { path: "a.ts" });
	await m.ran("bash", { command: "make test" });
	assert.equal(await m.settle("直して、テストも通りました。"), undefined);
	await m.fire("input", { text: "設定はどうなってる？", source: "interactive" });
	assert.equal((await m.settle("設定ファイルはどこにありますか？"))?.continue, true);
});
