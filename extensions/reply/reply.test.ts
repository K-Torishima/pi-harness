import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { asksForDetail, checkReply, japaneseShare } from "./shape.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const JA = "どこまで終わった？";

test("a short, plain Japanese reply passes", () => {
	assert.deepEqual(checkReply("テストを足して、15 件すべて通りました。\n次は README を更新します。", JA), []);
});

test("English to a Japanese writer is flagged; code and short replies are not", () => {
	assert.match(checkReply("I fixed the bug in the parser and all the tests pass now. Next I will update the docs.", JA)[0], /Reply in Japanese/);
	assert.deepEqual(checkReply("OK", JA), []);
	assert.deepEqual(checkReply("直しました。\n```ts\nconst answer = computeTheThing(input, options);\nexport default answer;\n```", JA), []);
	assert.deepEqual(checkReply("I fixed the bug in the parser and all the tests pass now.", "fix the parser"), []);
	assert.deepEqual(checkReply("I fixed the bug in the parser and all the tests pass now.", "変更内容を英語で書いて"), [], "English was asked for");
});

test("length counts prose only, and asking for detail lifts the limit", () => {
	const long = "あ".repeat(700);
	assert.match(checkReply(long, JA)[0], /too long \(700 characters/);
	assert.deepEqual(checkReply(long, "詳しく説明して"), []);
	assert.deepEqual(checkReply(long, "改善案を 20 個出して"), [], "an explicit count asks for that much");
	assert.deepEqual(checkReply(`短いです。\n\`\`\`\n${"x\n".repeat(80)}\`\`\``, JA), []);
	assert.match(checkReply(Array.from({ length: 20 }, (_, i) => `- 項目 ${i}`).join("\n"), JA)[0], /20 lines/);
});

test("issue numbers need a title or link", () => {
	assert.match(checkReply("#39 と #41 を確認しました。", JA).join(), /#39, #41 by number only/);
	assert.deepEqual(checkReply("#39「Checks 読取権限の追加」は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("[#39](https://github.com/o/r/issues/39) は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("#39 (Checks 権限) は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("https://github.com/o/r/pull/12 の #12 はマージ済みです。", JA), []);
	assert.deepEqual(checkReply("色は #fff にしました。見出しは ## です。", JA), []);
});

test("letter options must be spelled out", () => {
	assert.match(checkReply("A と B のどちらにしますか？", JA).join(), /Spell the options out/);
	assert.deepEqual(checkReply("どちらにしますか？\nA. Postgres を使う\nB. SQLite を使う", JA), []);
});

test("a preamble first line is flagged", () => {
	assert.match(checkReply("確認しました。テストは通っています。", JA).join(), /preamble/);
	assert.match(checkReply("Let me check that. Done.", "check it").join(), /preamble/);
	assert.deepEqual(checkReply("テストは通っています。確認しました。", JA), []);
});

test("helpers", () => {
	assert.ok(japaneseShare("日本語の文") > 0.9);
	assert.equal(japaneseShare("123 !!"), 0);
	assert.ok(asksForDetail("全部出して"));
	assert.ok(!asksForDetail("どう？"));
});

async function setup(reply: string, user = JA) {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	m.entries.push({ type: "message", message: { role: "user", content: user } });
	await m.fire("input", { text: user, source: "interactive" });
	const settle = () =>
		m.fire("agent_before_settle", {
			outcome: "completed",
			entries: [],
			continue: false,
			// The real shape: projected entries, and canContinue false right after the assistant's reply
			context: {
				canContinue: false,
				contextEntries: [
					{ sourceEntry: { id: "u1", type: "message" }, messages: [{ role: "user", content: user }] },
					{ sourceEntry: { id: "a1", type: "message" }, messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] },
				],
			},
		});
	return { ...m, settle };
}

test("a reply with problems is sent back once, with the first version dropped from context", async () => {
	const m = await setup("I checked #39 and it is waiting on an admin to grant the permission.");
	const r = await m.settle();
	assert.equal(r?.continue, true);
	const entries = r?.entries as { type: string; targetId?: string; content?: string }[];
	assert.deepEqual(entries[0], { type: "context_edit", targetId: "a1", replacement: null });
	assert.match(String(entries[1].content), /Reply in Japanese[\s\S]*#39 by number only[\s\S]*<<<\nI checked #39/);
	assert.equal(await m.settle(), undefined, "only once per request");
});

test("a fine reply, or one another extension already continues, is left alone", async () => {
	const fine = await setup("管理者の権限待ちで止まっています。");
	assert.equal(await fine.settle(), undefined);
	const m = await setup("I checked it.");
	const r = await m.fire("agent_before_settle", { outcome: "completed", entries: [], continue: true, context: { canContinue: true, contextEntries: [] } });
	assert.equal(r, undefined);
});
