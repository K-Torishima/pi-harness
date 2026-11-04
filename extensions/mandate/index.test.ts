/** Drive mandate's handlers with fake events, loaded through pi's own extension loader */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Entry, loadExtension } from "../../test/load-extension.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const tool = m.ext.tools.get("mandate").definition;
	const callTool = async (params: Record<string, unknown>) => {
		const r = await tool.execute("id", params, undefined, undefined, m.ctx);
		return r.content[0].text as string;
	};
	const userSays = async (text: string) => {
		m.entries.push({ type: "message", message: { role: "user", content: text } });
		await m.fire("input", { text, source: "interactive" });
	};
	return { ...m, callTool, userSays };
}

test("a question starts in look and edits are blocked", async () => {
	const m = await setup();
	await m.userSays("このリポジトリ何してるの？");
	const r = await m.fire("tool_call", { toolName: "edit", input: { path: "a.ts" } });
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /look mode/);
	assert.equal(await m.bash("git status"), undefined);
});

test("do needs a quote from the latest user message", async () => {
	const m = await setup();
	await m.userSays("この関数のバグを直して");
	assert.match(await m.callTool({ action: "set_mode", mode: "do", quote: "全部やって" }), /Rejected/);
	assert.equal((await m.bash("git add -A"))?.block, true);
	assert.match(await m.callTool({ action: "set_mode", mode: "do", quote: "バグを直して" }), /Mode is now do/);
	assert.equal(await m.bash("git add -A"), undefined);
	assert.equal(await m.fire("tool_call", { toolName: "write", input: { path: "a.ts" } }), undefined);
});

test("a new typed message resets to look, but steering mid-run does not", async () => {
	const m = await setup();
	await m.userSays("実装して");
	await m.callTool({ action: "set_mode", mode: "do", quote: "実装して" });
	await m.fire("input", { text: "どこまで？", source: "interactive", streamingBehavior: "steer" });
	assert.equal(await m.bash("touch x"), undefined);
	await m.userSays("これってどういう意味？");
	assert.equal((await m.bash("touch x"))?.block, true);
});

test("outward actions need a grant even in do, and grants last for the session", async () => {
	const m = await setup();
	await m.userSays("コミットして");
	await m.callTool({ action: "set_mode", mode: "do", quote: "コミットして" });
	assert.equal(await m.bash("git commit -m x"), undefined);
	const push = await m.bash("git push");
	assert.equal(push?.block, true);
	assert.match(String(push?.reason), /grant push/);
	assert.match(await m.callTool({ action: "grant", grant: "push", quote: "pushして" }), /Rejected/);

	await m.userSays("pushもして");
	await m.callTool({ action: "set_mode", mode: "do", quote: "pushもして" });
	assert.match(await m.callTool({ action: "grant", grant: "push", quote: "pushもして" }), /Granted push/);
	assert.equal(await m.bash("git push"), undefined);
	assert.deepEqual(m.appended.at(-1), { customType: "mandate", data: { grants: ["push"] } });

	await m.userSays("次はPRの説明見せて");
	await m.callTool({ action: "set_mode", mode: "do", quote: "PRの説明見せて" });
	assert.equal(await m.bash("git push"), undefined, "push grant still holds");
	assert.equal((await m.bash("gh pr create --fill"))?.block, true, "pr was never granted");
});

test("/goal switches to do and shows it", async () => {
	const m = await setup();
	await m.userSays("/goal テストを足す");
	m.bus.emit("goal:start", { objective: "テストを足す" });
	await m.fire("input", { text: "Goal: テストを足す", source: "extension" });
	assert.equal(await m.bash("touch a.test.ts"), undefined);
	assert.match(m.status.at(-1) ?? "", /^do 「テストを足す」/);
});

test("a follow-up queued mid-run resets to look when its run starts, not before", async () => {
	const m = await setup();
	await m.userSays("実装して");
	await m.callTool({ action: "set_mode", mode: "do", quote: "実装して" });
	await m.fire("input", { text: "この関数は何をしてる？", source: "interactive", streamingBehavior: "followUp" });
	assert.equal(await m.bash("touch x"), undefined, "the current run keeps working");
	await m.fire("agent_start");
	assert.equal((await m.bash("touch x"))?.block, true, "the follow-up starts in look");
});

test("only the current branch counts for quotes and restored grants", async () => {
	const m = await setup();
	m.otherBranch.push({ type: "message", message: { role: "user", content: "pushして" } });
	await m.userSays("この差分どう思う？");
	assert.match(await m.callTool({ action: "grant", grant: "push", quote: "pushして" }), /Rejected/);

	m.otherBranch.push({ type: "custom", customType: "mandate", data: { grants: ["push"] } } as Entry);
	await m.fire("session_start", { reason: "resume" });
	await m.userSays("直して");
	await m.callTool({ action: "set_mode", mode: "do", quote: "直して" });
	assert.equal((await m.bash("git push"))?.block, true, "a grant from another branch does not leak in");
});

test("a block before the go-ahead does not turn off the send-back", async () => {
	const m = await setup();
	await m.userSays("これ直しておいて");
	assert.equal((await m.fire("tool_call", { toolName: "edit", input: { path: "a.ts" } }))?.block, true);
	await m.callTool({ action: "set_mode", mode: "do", quote: "直しておいて" });
	const r = await m.fire("agent_before_settle", settle("直しました。次も進めましょうか？"));
	assert.equal(r?.continue, true);
});

const settle = (text: string, extra: Record<string, unknown> = {}) => ({
	outcome: "completed",
	entries: [],
	continue: false,
	context: { canContinue: true, contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
	...extra,
});

test("in do, a reply asking permission is sent back once", async () => {
	const m = await setup();
	await m.userSays("リファクタして");
	await m.callTool({ action: "set_mode", mode: "do", quote: "リファクタして" });
	const first = await m.fire("agent_before_settle", settle("1つ目を直しました。次も進めてよいですか？"));
	assert.equal(first?.continue, true);
	const second = await m.fire("agent_before_settle", settle("2つ目も直しました。次も進めてよいですか？"));
	assert.equal(second, undefined, "only once per request");
});

test("no send-back in look, after a block, or when another extension already continues", async () => {
	const look = await setup();
	await look.userSays("説明して");
	assert.equal(await look.fire("agent_before_settle", settle("進めますか？")), undefined);

	const afterBlock = await setup();
	await afterBlock.userSays("直して");
	await afterBlock.callTool({ action: "set_mode", mode: "do", quote: "直して" });
	await afterBlock.bash("git push");
	assert.equal(await afterBlock.fire("agent_before_settle", settle("pushしてよいですか？")), undefined);

	const goal = await setup();
	await goal.userSays("直して");
	await goal.callTool({ action: "set_mode", mode: "do", quote: "直して" });
	assert.equal(await goal.fire("agent_before_settle", settle("進めますか？", { continue: true })), undefined);
});

test("/allow and /revoke manage grants", async () => {
	const m = await setup();
	await m.command("allow", "pr issue");
	assert.match(m.notes.at(-1) ?? "", /Allowed: pr, issue/);
	await m.command("revoke", "pr");
	assert.match(m.notes.at(-1) ?? "", /Allowed now: issue/);
	await m.command("allow", "everything");
	assert.match(m.notes.at(-1) ?? "", /Use \/allow/);
});
