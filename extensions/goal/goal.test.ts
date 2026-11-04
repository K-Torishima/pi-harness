import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// The real shape right after the assistant's reply: canContinue is false until a message is added
const settle = (extra: Record<string, unknown> = {}) => ({ outcome: "completed", entries: [], continue: false, context: { canContinue: false, contextMessages: [] }, ...extra });

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const tool = m.ext.tools.get("goal").definition;
	const call = async (params: Record<string, unknown>) => (await tool.execute("id", params, undefined, undefined, m.ctx)).content[0].text as string;
	const start = (text: string) => m.command("goal", text);
	return { ...m, call, start };
}

test("an active goal keeps going after a reply, even though canContinue is false at that point", async () => {
	const m = await setup();
	await m.start("add tests");
	assert.match(String(m.sent[0]), /^Goal: add tests/);
	const r = await m.fire("agent_before_settle", settle());
	assert.equal(r?.continue, true);
	assert.match(String((r?.entries as { content?: string }[])[0].content), /\[goal 1\/15\]/);
});

test("a goal stops on done, blocked, Esc, and errors", async () => {
	const m = await setup();
	await m.start("add tests");
	await m.call({ action: "set_criteria", criteria: ["tests pass"] });
	await m.call({ action: "done", evidence: "ran make test" });
	assert.equal(await m.fire("agent_before_settle", settle()), undefined);

	const aborted = await setup();
	await aborted.start("x");
	assert.equal(await aborted.fire("agent_before_settle", settle({ outcome: "aborted" })), undefined);
	assert.equal(await aborted.fire("agent_before_settle", settle()), undefined, "the goal was dropped");
});
