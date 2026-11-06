/** Drive the PR gate with fake tool events */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const REPORTS: Record<string, string> = { simplify: "Simplified: 1 edit, tests pass", review: "Verdict: ready to merge", security: "**Security:** no issues found" };

async function setup() {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const reports = (skill: string) => (REPORTS[skill] ? m.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: REPORTS[skill] }] } }) : undefined);
	const ok = (toolName: string, input: Record<string, unknown>) => m.fire("tool_result", { toolName, input, isError: false, content: [] });
	return {
		...m,
		edit: () => ok("edit", { path: "src/a.ts" }),
		// Loading a skill, then (for review and security) the report it asks for
		loads: async (skill: string) => {
			await ok("read", { path: `/somewhere/pi-harness/skills/${skill}/SKILL.md` });
			await reports(skill);
		},
		types: async (text: string) => {
			await m.fire("input", { text, source: "interactive" });
			await reports(text.match(/^\/skill:(\w+)/)?.[1] ?? "");
		},
		readsOnly: (skill: string) => ok("read", { path: `/somewhere/pi-harness/skills/${skill}/SKILL.md` }),
		says: (text: string) => m.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } }),
		pr: () => m.bash("gh pr create --fill"),
		prDone: () => ok("bash", { command: "gh pr create --fill" }),
	};
}

test("a PR is blocked until simplify, review, and security have run", async () => {
	const m = await setup();
	await m.edit();
	const r = await m.pr();
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /simplify .*then review .*then security/);
	await m.loads("simplify");
	assert.match(String((await m.pr())?.reason), /review/);
	await m.loads("review");
	assert.match(String((await m.pr())?.reason), /security \(read skills\/security\/SKILL\.md/);
	await m.types("/skill:security");
	assert.equal(await m.pr(), undefined);
});

test("a change after the review needs another review, but not another simplify", async () => {
	const m = await setup();
	await m.edit();
	await m.types("/skill:simplify");
	await m.types("/skill:review src");
	await m.types("/skill:security");
	await m.edit();
	const r = await m.pr();
	assert.equal(r?.block, true);
	assert.doesNotMatch(String(r?.reason), /simplify/);
	assert.match(String(r?.reason), /review .*security/);
	await m.loads("review");
	await m.loads("security");
	assert.equal(await m.pr(), undefined);
});

test("simplify run before the work started does not count", async () => {
	const m = await setup();
	await m.loads("simplify");
	await m.edit();
	await m.loads("review");
	assert.match(String((await m.pr())?.reason), /simplify/);
});

test("after a PR is opened, the next one needs simplify only for new changes", async () => {
	const m = await setup();
	await m.edit();
	await m.loads("simplify");
	await m.loads("review");
	await m.prDone();
	await m.edit();
	assert.match(String((await m.pr())?.reason), /simplify/);
});

test("git commits and failed edits are not changes; other commands pass", async () => {
	const m = await setup();
	await m.loads("simplify");
	await m.loads("review");
	await m.loads("security");
	await m.fire("tool_result", { toolName: "bash", input: { command: "git add -A && git commit -m x" }, isError: false, content: [] });
	await m.fire("tool_result", { toolName: "edit", input: { path: "a.ts" }, isError: true, content: [] });
	assert.equal(await m.pr(), undefined);
	assert.equal(await m.bash("gh pr view 3"), undefined);
	assert.equal(await m.bash('git commit -m "before gh pr create"'), undefined);
});

test("git commands that bring in code, and changes chained after git add, need a new review", async () => {
	for (const command of ["git cherry-pick abc", "git stash pop", "git pull", "git apply fix.patch", "git add -A && sed -i 's/a/b/' src/x.ts"]) {
		const m = await setup();
		await m.loads("simplify");
		await m.loads("review");
		await m.fire("tool_result", { toolName: "bash", input: { command }, isError: false, content: [] });
		assert.equal((await m.pr())?.block, true, command);
	}
});

test("/reviewed says what is missing", async () => {
	const m = await setup();
	await m.edit();
	await m.command("reviewed", "");
	assert.match(m.notes.at(-1) ?? "", /Before a PR: simplify .*review .*security/);
});

test("reading review or security opens nothing until its report starts", async () => {
	const m = await setup();
	await m.edit();
	await m.loads("simplify");
	await m.readsOnly("review");
	await m.readsOnly("security");
	assert.match(String((await m.pr())?.reason), /review .*security/);
	await m.says("見ました。問題ありません。");
	assert.equal((await m.pr())?.block, true, "a report without its first line does not count");
	await m.says("Verdict: ready to merge\n1. nothing");
	await m.says("Security: nothing exposed (docs only)");
	assert.equal(await m.pr(), undefined);
});

test("/skill:security-notes is another skill", async () => {
	const m = await setup();
	await m.edit();
	await m.loads("simplify");
	await m.loads("review");
	await m.fire("input", { text: "/skill:security-notes", source: "interactive" });
	await m.says("Security: no issues found");
	assert.equal((await m.pr())?.block, true);
});

test("polish: simplify's own edits do not ask for another simplify", async () => {
	// A session that starts on already-committed work: the first change is simplify's own edit
	const m = await setup();
	await m.readsOnly("polish/../simplify");
	await m.edit();
	await m.readsOnly("polish/../review");
	await m.says("Verdict: ready to merge\n1. nothing\nSimplified: 1 edit, tests pass");
	await m.types("/skill:security");
	assert.equal(await m.pr(), undefined);
});

test("skill files count by any path the read tool accepts", async () => {
	for (const path of ["@skills/polish/../review/SKILL.md", "skills/review/SKILL.md", "/x/pi-harness/skills/polish/../review/SKILL.md"]) {
		const m = await setup();
		await m.edit();
		await m.loads("simplify");
		await m.fire("tool_result", { toolName: "read", input: { path }, isError: false, content: [] });
		await m.says("Verdict: ready to merge");
		await m.types("/skill:security");
		assert.equal(await m.pr(), undefined, path);
	}
});
