import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { asksForFact, checkClaims, claimsItWorks, emptyLedger, record, stepsOf } from "./claims.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const bash = (command: string) => stepsOf("bash", { command });

test("stepsOf sorts tool calls into look, change, and verify", () => {
	assert.deepEqual(stepsOf("read", { path: "a.ts" }), ["look"]);
	assert.deepEqual(stepsOf("edit", { path: "a.ts" }), ["change"]);
	assert.deepEqual(bash("rg foo src"), ["look"]);
	assert.deepEqual(bash("sed -i '' 's/a/b/' a.ts"), ["change"]);
	for (const c of ["make test", "make", "npm test", "npm run lint", "pnpm build", "node --test 'x/**/*.test.ts'", "npx vitest run", "cd app && npx tsc --noEmit", "pytest -q", "go test ./...", "curl -s localhost:3000/health"])
		assert.deepEqual(bash(c), ["verify"], c);
	assert.deepEqual(stepsOf("anchor", { action: "set_next" }), []);
});

test("review regressions: git records nothing, steps keep their order, and only real checks verify", () => {
	assert.deepEqual(bash("git add -A && git commit -m fix"), [], "recording code is not changing it");
	assert.deepEqual(bash("git checkout -b feat/x"), []);
	assert.deepEqual(bash("npm test && sed -i '' s/a/b/ a.ts"), ["verify", "change"]);
	assert.deepEqual(bash("eslint --fix src"), ["change"]);
	assert.deepEqual(bash("npx prettier --write ."), ["change"]);
	assert.deepEqual(bash("git commit -m 'wip; make test later'"), [], "text inside a message is not a command");
	assert.deepEqual(bash("curl -s https://docs.example.com/api"), ["look"], "reading docs is not a check");
	assert.notDeepEqual(bash("make link"), ["verify"]);
	assert.notDeepEqual(bash("make clean"), ["verify"]);
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

test("denials are not claims, and closing questions are not fact questions", () => {
	for (const r of ["テストは通りませんでした。", "テストが通らない状態です。", "ビルドが成功しませんでした。", "I have not verified this yet.", "Tests don't pass yet.", "まだ検証していません。"])
		assert.equal(claimsItWorks(r), undefined, r);
	assert.equal(claimsItWorks("1件は通りませんでしたが、直した後はテストが通りました。")?.kind, "passes", "a later affirmation still counts");
	assert.ok(!asksForFact("設定ファイルのパスを確認しました。次に進めますか？"), "the path sentence is not the question");
	assert.ok(!asksForFact("他に質問はありますか？"));
	assert.ok(!asksForFact("A と B、どれがいいですか？"));
	assert.ok(!asksForFact("Shall I open the PR? URL: https://example.com"));
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

test("committing after a green test run does not undo the test run", async () => {
	const m = await setup();
	await m.ran("edit", { path: "a.ts" });
	await m.ran("bash", { command: "make test" });
	await m.ran("bash", { command: "git add -A && git commit -m fix" });
	assert.equal(await m.settle("テストも通りました。コミットしました。"), undefined);
});

test("each /goal round gets its own check", async () => {
	const m = await setup();
	await m.ran("edit", { path: "a.ts" });
	assert.equal((await m.settle("テストも通りました。"))?.continue, true);
	await m.fire("message_start", { message: { role: "custom", customType: "goal" } });
	await m.ran("edit", { path: "b.ts" });
	assert.equal((await m.settle("テストも通りました。"))?.continue, true, "round 2 is checked too");
});

test("a backed claim passes, and a new request starts a new tally", async () => {
	const m = await setup();
	await m.ran("edit", { path: "a.ts" });
	await m.ran("bash", { command: "make test" });
	assert.equal(await m.settle("直して、テストも通りました。"), undefined);
	await m.fire("input", { text: "設定はどうなってる？", source: "interactive" });
	assert.equal((await m.settle("設定ファイルはどこにありますか？"))?.continue, true);
});
