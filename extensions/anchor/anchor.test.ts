import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { decisionKind, fresh, push, reminder } from "./ledger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("decisionKind spots decisions and rejections, not questions", () => {
	for (const t of ["じゃあ Postgres にしよう", "それで行こう", "A案で決定", "SQLite でいいよ", "let's go with the queue"]) assert.equal(decisionKind(t), "decides", t);
	for (const t of ["ポーリングはいらない", "キャッシュはなしで", "それはやめよう", "Redis は使わない", "don't use polling"]) assert.equal(decisionKind(t), "rejects", t);
	for (const t of ["Postgres にしようか？", "どこまで終わった？", "テスト足して", "ログを見て"]) assert.equal(decisionKind(t), undefined, t);
});

test("push keeps the newest items without duplicates", () => {
	assert.deepEqual(push(["a", "b"], "a", 10), ["b", "a"]);
	assert.deepEqual(push(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
});

test("reminder lists decided, rejected, and open, and asks to record a pending decision", () => {
	const s = { ...fresh(), focus: "build the sync", decisions: ["use webhooks"], rejected: ["polling"], open: ["retry count"] };
	const text = reminder(s, { kind: "rejects", text: "ポーリングはいらない" });
	assert.match(text, /Decided \(treat as settled, not as proposals\):\n- use webhooks/);
	assert.match(text, /Rejected \(do not propose again\):\n- polling/);
	assert.match(text, /Still open .*:\n1\. retry count/);
	assert.match(text, /looks like it rejects something: "ポーリングはいらない".*add_rejected/);
	assert.doesNotMatch(reminder(fresh()), /Decided \(|Rejected \(|Still open|looks like/);
});

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const tool = m.ext.tools.get("anchor").definition;
	const call = async (action: string, text: string) => (await tool.execute("id", { action, text }, undefined, undefined, m.ctx)).content[0].text as string;
	const lastCall = async () => {
		const r = await m.fire("context", { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		const messages = r?.messages as { role: string; content: string }[];
		return messages;
	};
	return { ...m, call, lastCall };
}

test("the reminder is added to every model call, right before the user's latest message, and not stored", async () => {
	const m = await setup();
	await m.call("add_decision", "use webhooks");
	const messages = await m.lastCall();
	assert.deepEqual(
		messages.map((x) => x.role),
		["custom", "user"],
	);
	assert.match(messages[0].content, /- use webhooks/);
	assert.equal(m.appended.filter((a) => a.customType !== "anchor").length, 0, "only state entries are stored");
});

test("after a tool result, the conversation still ends with the tool result (no trailing reminder to loop on)", async () => {
	const m = await setup();
	const convo = [
		{ role: "user", content: "old", timestamp: 1 },
		{ role: "assistant", content: [], timestamp: 2 },
		{ role: "user", content: "new request", timestamp: 3 },
		{ role: "assistant", content: [{ type: "toolCall", name: "anchor" }], timestamp: 4 },
		{ role: "toolResult", content: [{ type: "text", text: "Updated." }], timestamp: 5 },
	];
	const r = (await m.fire("context", { messages: convo }))?.messages as { role: string; content: unknown }[];
	assert.deepEqual(
		r.map((x) => x.role),
		["user", "assistant", "custom", "user", "assistant", "toolResult"],
	);
});

test("a typed decision stays flagged until the AI records it", async () => {
	const m = await setup();
	await m.fire("input", { text: "ポーリングはいらない", source: "interactive" });
	assert.match((await m.lastCall())[0].content, /looks like it rejects/);
	await m.call("add_rejected", "polling");
	assert.doesNotMatch((await m.lastCall())[0].content, /looks like it/);
	await m.fire("input", { text: "どう思う？", source: "interactive" });
	assert.doesNotMatch((await m.lastCall())[0].content, /looks like it/);
});

test("set_next stops updating after two calls in one run, and resets on the next run", async () => {
	const m = await setup();
	await m.call("set_next", "one");
	await m.call("set_next", "two");
	assert.match(await m.call("set_next", "three"), /already set/);
	await m.fire("agent_start");
	assert.equal(await m.call("set_next", "four"), "Updated.");
});

test("open items can be added and closed by number", async () => {
	const m = await setup();
	await m.call("add_open", "retry count");
	await m.call("add_open", "timeout");
	assert.match(await m.call("close_open", "5"), /Pass the number/);
	await m.call("close_open", "1");
	assert.match((await m.lastCall())[0].content, /1\. timeout/);
});

test("state is restored from the current branch only", async () => {
	const m = await setup();
	m.otherBranch.push({ type: "custom", customType: "anchor", data: { focus: "other", decisions: ["from another branch"] } });
	m.entries.push({ type: "custom", customType: "anchor", data: { focus: "here", rejected: ["polling"] } });
	await m.fire("session_start", { reason: "resume" });
	const text = (await m.lastCall())[0].content;
	assert.match(text, /Current focus: here/);
	assert.match(text, /- polling/);
	assert.doesNotMatch(text, /another branch/);
});
