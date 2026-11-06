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
	assert.match(checkReply(long, "src/foo.ts の 120 行目でエラーが出る、直して").join(), /too long/, "a line number is not a count");
	assert.deepEqual(checkReply(`短いです。\n\`\`\`\n${"x\n".repeat(80)}\`\`\``, JA), []);
	assert.match(checkReply(Array.from({ length: 20 }, (_, i) => `- 項目 ${i}`).join("\n"), JA)[0], /20 lines/);
});

test("issue numbers need a title or link", () => {
	assert.match(checkReply("#39 と #41 を確認しました。", JA).join(), /#39, #41 by number only/);
	assert.deepEqual(checkReply("#39「Checks 読取権限の追加」は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("[#39](https://github.com/o/r/issues/39) は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("#39 (Checks 権限) は管理者待ちです。", JA), []);
	assert.deepEqual(checkReply("起動方法整理 #157 と クラウドAI検証 #156 はクローズ済みです。", JA), [], "a title before the number");
	assert.match(checkReply("未完了は #43 です。", JA).join(), /#43 by number only/, "a particle is not a title");
	assert.deepEqual(checkReply("構成は、親Issue #1〜#9と、作業Issue #10〜#54です。", JA), [], "a range");
	assert.deepEqual(checkReply("#345 は完了しました。", "design-system の #345 を進めてください。"), [], "the user wrote it");
	assert.deepEqual(checkReply("https://github.com/o/r/pull/12 の #12 はマージ済みです。", JA), []);
	assert.deepEqual(checkReply("色は #fff にしました。見出しは ## です。", JA), []);
	assert.deepEqual(checkReply("背景色は #333 に変えました。", JA), [], "a color made of digits");
	assert.match(checkReply("#333 の件、色の指定を直しました。\n#3333 は別です。", JA).join(), /#3333/);
});

test("letter options must be spelled out", () => {
	assert.match(checkReply("A と B のどちらにしますか？", JA).join(), /Spell the options out/);
	assert.deepEqual(checkReply("どちらにしますか？\nA. Postgres を使う\nB. SQLite を使う", JA), []);
	assert.deepEqual(checkReply("- **A**: Postgres を使う\n- **B**: SQLite を使う\nA か B で選んでください。", JA), []);
	assert.deepEqual(checkReply("A/B テストの仕組みを追加しました。", JA), [], "A/B testing is not a choice");
});

test("a preamble first line is flagged", () => {
	assert.match(checkReply("確認しました。テストは通っています。", JA).join(), /preamble/);
	assert.match(checkReply("Let me check that. Done.", "check it").join(), /preamble/);
	assert.deepEqual(checkReply("テストは通っています。確認しました。", JA), []);
	assert.deepEqual(checkReply("以下の 3 ファイルを直しました。", JA), [], "a conclusion that starts with 以下");
});

test("helpers", () => {
	assert.ok(japaneseShare("日本語の文") > 0.9);
	assert.equal(japaneseShare("123 !!"), 0);
	assert.ok(asksForDetail("全部出して"));
	assert.ok(!asksForDetail("どう？"));
});

async function setup(reply: string, user = JA, earlier: string[] = []) {
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
				contextMessages: [
					...earlier.map((text) => ({ role: "assistant", content: [{ type: "text", text }] })),
					{ role: "user", content: user },
					{ role: "assistant", content: [{ type: "text", text: reply }] },
				],
			},
		});
	return { ...m, settle };
}

test("a #number explained in an earlier reply is not sent back again", async () => {
	const linked = "[#43](https://github.com/o/r/issues/43) Crashlytics取得失敗は未解決です。";
	assert.equal(await (await setup("#43を調べた結果、まだ未解決です。", JA, [linked])).settle(), undefined);
	assert.equal((await (await setup("#43を調べた結果、まだ未解決です。")).settle())?.continue, true, "without the earlier reply it is bare");
});

test("a reply with problems is sent back once, with the first version dropped from context", async () => {
	const m = await setup("I checked #39 and it is waiting on an admin to grant the permission.");
	const r = await m.settle();
	assert.equal(r?.continue, true);
	const entries = r?.entries as { type: string; targetId?: string; content?: string }[];
	assert.deepEqual(entries[0], { type: "context_edit", targetId: "a1", replacement: null });
	assert.match(String(entries[1].content), /Reply in Japanese[\s\S]*#39 by number only[\s\S]*<<<\nI checked #39/);
	assert.equal(await m.settle(), undefined, "only once per request");
});

test("a queued follow-up or a /goal kickoff starts a new request; the language check keeps the user's own words", async () => {
	const m = await setup("I checked it and it is waiting on an admin to grant the permission.");
	assert.equal((await m.settle())?.continue, true);
	await m.fire("input", { text: "Goal: 権限を確認する", source: "extension" });
	const again = await m.settle();
	assert.equal(again?.continue, true, "the kickoff started a new request, and the user's Japanese still counts");

	const f = await setup("I checked it and it is waiting on an admin to grant the permission.");
	await f.settle();
	await f.fire("input", { text: "次は？", source: "interactive", streamingBehavior: "followUp" });
	assert.equal(await f.settle(), undefined, "still the first request until the follow-up's run starts");
	await f.fire("agent_start");
	assert.equal((await f.settle())?.continue, true);
});

test("each /goal round's reply gets checked", async () => {
	const m = await setup("I checked it and it is waiting on an admin to grant the permission.");
	assert.equal((await m.settle())?.continue, true);
	await m.fire("message_start", { message: { role: "custom", customType: "goal" } });
	assert.equal((await m.settle())?.continue, true);
});

test("a fine reply, or one another extension already continues, is left alone", async () => {
	const fine = await setup("管理者の権限待ちで止まっています。");
	assert.equal(await fine.settle(), undefined);
	const m = await setup("I checked it.");
	const r = await m.fire("agent_before_settle", { outcome: "completed", entries: [], continue: true, context: { canContinue: true, contextEntries: [] } });
	assert.equal(r, undefined);
});
