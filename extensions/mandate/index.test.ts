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
	// The real shape: right after the assistant's reply, canContinue is false
	context: { canContinue: false, contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
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

test("in look, a reply that blames the mode for not acting is sent back once", async () => {
	const m = await setup();
	await m.userSays("note.txt の末尾に改行を1つ足して");
	const r = await m.fire("agent_before_settle", settle("現在は読み取り専用（look）なので、変更していません。"));
	assert.equal(r?.continue, true);
	assert.match(String((r?.entries as { content?: string }[])[0].content), /set_mode do with their exact words/);
	assert.equal(await m.fire("agent_before_settle", settle("現在は look なので変更していません。")), undefined, "only once");
});

test("no send-back in look, after a block, or when another extension already continues", async () => {
	// A look the user chose with /mode is respected
	const look = await setup();
	await look.userSays("説明して");
	await look.command("mode", "look");
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

test("the default look is described as a default, not as the user's instruction", async () => {
	const m = await setup();
	await m.userSays("note.txt に改行を足して");
	const r = await m.fire("before_agent_start", { messageType: "user", prompt: "note.txt に改行を足して" });
	const text = String((r?.message as { content?: string })?.content);
	assert.match(text, /default for every new message, not something the user asked for/);
	assert.doesNotMatch(text, /change nothing/);
});

test("in the default look, a reply that asks permission instead of raising the mode is sent back", async () => {
	const m = await setup();
	await m.userSays("note.txt の末尾に改行を足して");
	assert.equal((await m.fire("agent_before_settle", settle("改行を足しましょうか？")))?.continue, true);
});

test("a plan the user asked for, or a reply that only explains read-only, is not sent back", async () => {
	const plan = await setup();
	await plan.userSays("ログインのバグを直す計画を立てて");
	await plan.callTool({ action: "set_mode", mode: "plan", quote: "直す計画を立てて" });
	assert.equal(await plan.fire("agent_before_settle", settle("計画です。(plan) No files were changed.")), undefined);

	const explain = await setup();
	await explain.userSays("なんで書き込みに失敗するの？");
	assert.equal(await explain.fire("agent_before_settle", settle("ボリュームが read-only でマウントされているためです。")), undefined);

	const long = await setup();
	await long.userSays("このモジュールを説明して");
	const reply = `まず、このモジュールは read-only のキャッシュを持ちます。${"説明が続きます。".repeat(60)}以上です。`;
	assert.equal(await long.fire("agent_before_settle", settle(reply)), undefined, "an early mention is not a stall");
});

test("block reasons no longer say 'change nothing'", async () => {
	const m = await setup();
	await m.userSays("見て");
	const r = await m.fire("tool_call", { toolName: "edit", input: { path: "a.ts" } });
	assert.doesNotMatch(String(r?.reason), /change nothing/);
	assert.match(String(r?.reason), /edits are blocked until the mode is raised/);
});
