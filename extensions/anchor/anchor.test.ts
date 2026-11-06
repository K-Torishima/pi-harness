import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { decisionKinds, fresh, push, reminder } from "./ledger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("decisionKinds spots decisions and rejections", () => {
	for (const t of ["じゃあ Postgres にしよう", "それで行こう", "A案で決定", "SQLite でいいよ", "let's go with the queue", "we decided to use SQS"])
		assert.deepEqual(decisionKinds(t), ["decides"], t);
	for (const t of ["ポーリングはいらない", "キャッシュはなしで", "それはやめよう", "Redis は使わない", "don't use polling"]) assert.deepEqual(decisionKinds(t), ["rejects"], t);
	assert.deepEqual(decisionKinds("Redis はやめて Postgres にしよう"), ["decides", "rejects"]);
});

test("decisionKinds ignores questions, wavering, and ordinary instructions", () => {
	for (const t of [
		"Postgres にしようか？",
		"Postgres にしようかな",
		"どっちにしようか迷ってる",
		"どこまで終わった？",
		"テスト足して",
		"不要なファイルを消して",
		"心配いらない",
		"drop the table and recreate it",
		"don't do anything yet",
		"I haven't decided yet",
		"not sure what to go with.",
	])
		assert.deepEqual(decisionKinds(t), [], t);
});

test("push keeps the newest items without duplicates", () => {
	assert.deepEqual(push(["a", "b"], "a", 10), ["b", "a"]);
	assert.deepEqual(push(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
});

test("reminder lists decided, rejected, and open, and asks to record a pending decision", () => {
	const s = { ...fresh(), focus: "build the sync", decisions: ["use webhooks"], rejected: ["polling"], open: ["retry count"] };
	const text = reminder(s, { kinds: ["decides", "rejects"], text: "Redis はやめて Postgres にしよう" });
	assert.match(text, /Decided \(treat as settled, not as proposals\):\n- use webhooks/);
	assert.match(text, /Rejected \(do not propose again\):\n- polling/);
	assert.match(text, /Still open .*:\n1\. retry count/);
	assert.match(text, /looks like it decides and rejects something.*add_decision and add_rejected/);
	assert.doesNotMatch(reminder(fresh()), /Decided \(|Rejected \(|Still open|looks like/);
});

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const tool = m.ext.tools.get("anchor").definition;
	const call = async (action: string, text: string) => (await tool.execute("id", { action, text }, undefined, undefined, m.ctx)).content[0].text as string;
	/** The reminder written at the start of a request */
	const reminderNow = async () => String(((await m.fire("before_agent_start", { prompt: "hi" }))?.message as { content?: string })?.content ?? "");
	const context = async (messages: Record<string, unknown>[]) => (await m.fire("context", { messages }))?.messages as Record<string, unknown>[] | undefined;
	return { ...m, call, reminderNow, context };
}

test("the reminder is a hidden message written once at the start of a request", async () => {
	const m = await setup();
	await m.call("add_decision", "use webhooks");
	const r = await m.fire("before_agent_start", { prompt: "hi" });
	assert.deepEqual({ ...(r?.message as object), content: undefined }, { customType: "anchor", content: undefined, display: false });
	assert.match(await m.reminderNow(), /- use webhooks/);
});

test("model calls leave the conversation alone while the reminder is in it, so the prompt cache holds", async () => {
	const m = await setup();
	await m.reminderNow();
	await m.call("set_next", "something new");
	const convo = [{ role: "user" }, { role: "custom", customType: "anchor", content: "old" }, { role: "assistant" }, { role: "toolResult" }];
	assert.equal(await m.context(convo), undefined, "a change during the request does not rewrite or move it");
});

test("after compaction removes it, the same reminder comes back right after the summary", async () => {
	const m = await setup();
	assert.equal(await m.context([{ role: "user" }]), undefined, "nothing before the first request");
	const text = await m.reminderNow();
	const after = await m.context([{ role: "compactionSummary" }, { role: "assistant" }, { role: "toolResult" }]);
	assert.deepEqual(after?.map((x) => x.role), ["compactionSummary", "custom", "assistant", "toolResult"]);
	assert.equal(after?.[1].content, text);
	await m.call("add_decision", "later");
	const again = await m.context([{ role: "compactionSummary" }, { role: "assistant" }]);
	assert.equal(again?.[1].content, text, "the same text until the next request, so the next call hits the cache too");
});

test("a typed decision stays flagged until the AI records each kind; an extension message clears it", async () => {
	const m = await setup();
	await m.fire("input", { text: "Redis はやめて Postgres にしよう", source: "interactive" });
	assert.match(await m.reminderNow(), /looks like it decides and rejects/);
	await m.call("add_rejected", "Redis");
	assert.match(await m.reminderNow(), /looks like it decides something.*add_decision/);
	await m.call("add_decision", "Postgres");
	assert.doesNotMatch(await m.reminderNow(), /looks like it/);

	await m.fire("input", { text: "それでいいよ", source: "interactive" });
	assert.match(await m.reminderNow(), /looks like it decides/);
	await m.fire("input", { text: "Goal: ship it", source: "extension" });
	assert.doesNotMatch(await m.reminderNow(), /looks like it/);
});

test("set_next stops after two calls per reply, and each user or /goal message starts a new count", async () => {
	const m = await setup();
	await m.call("set_next", "one");
	await m.call("set_next", "two");
	assert.match(await m.call("set_next", "three"), /already set/);
	await m.fire("message_start", { message: { role: "custom" } });
	assert.equal(await m.call("set_next", "four"), "Updated.");
	await m.fire("message_start", { message: { role: "toolResult" } });
	await m.call("set_next", "five");
	assert.match(await m.call("set_next", "six"), /already set/);
});

test("open items can be closed by a plain number only", async () => {
	const m = await setup();
	await m.call("add_open", "retry count");
	await m.call("add_open", "timeout");
	assert.match(await m.call("close_open", "5"), /Pass the number/);
	assert.match(await m.call("close_open", "1,2"), /Pass the number/);
	assert.match(await m.call("close_open", "2 (timeout)"), /Pass the number/);
	await m.call("close_open", "1");
	assert.match(await m.reminderNow(), /1\. timeout/);
});

test("state comes from the current branch, on startup and after /tree", async () => {
	const m = await setup();
	m.otherBranch.push({ type: "custom", customType: "anchor", data: { focus: "other", decisions: ["from another branch"] } });
	m.entries.push({ type: "custom", customType: "anchor", data: { focus: "here", rejected: ["polling"] } });
	await m.fire("session_start", { reason: "resume" });
	const text = await m.reminderNow();
	assert.match(text, /Current focus: here/);
	assert.match(text, /- polling/);
	assert.doesNotMatch(text, /another branch/);

	await m.call("add_decision", "use Postgres");
	m.entries.length = 0;
	m.entries.push({ type: "custom", customType: "anchor", data: { focus: "earlier" } });
	await m.fire("session_tree", {});
	const after = await m.reminderNow();
	assert.match(after, /Current focus: earlier/);
	assert.doesNotMatch(after, /Postgres/);
});
