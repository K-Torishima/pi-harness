/** Drive secrets against real temporary git repositories */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAKE } from "../../test/fake-secrets.ts";
import { loadExtension } from "../../test/load-extension.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
	dirs.push(dir);
	run(dir, "init", "-q");
	run(dir, "config", "user.email", "bot@users.noreply.github.com");
	run(dir, "config", "user.name", "bot");
	writeFileSync(join(dir, "a.txt"), "hello\n");
	run(dir, "add", ".");
	run(dir, "commit", "-qm", "init");
	return dir;
}
const load = (cwd: string) => loadExtension(join(HERE, "index.ts"), cwd);

test("secrets in tool output are hidden before the AI sees them", async () => {
	const m = await load(HERE);
	const r = await m.fire("tool_result", { toolName: "bash", content: [{ type: "text", text: `GITHUB_TOKEN=${FAKE.github}` }], isError: false });
	assert.deepEqual(r, { content: [{ type: "text", text: "GITHUB_TOKEN=[redacted GitHub token]" }] });
	assert.equal(await m.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "nothing here" }], isError: false }), undefined);
});

test("writing a redaction marker back into a file is blocked", async () => {
	const m = await load(HERE);
	const write = await m.fire("tool_call", { toolName: "write", input: { path: "c.yaml", content: "token: [redacted Slack token]\n" } });
	assert.equal(write?.block, true);
	const edit = await m.fire("tool_call", { toolName: "edit", input: { path: "c.yaml", edits: [{ oldText: "a", newText: "x [redacted GitHub token]" }] } });
	assert.equal(edit?.block, true);
	assert.equal(await m.fire("tool_call", { toolName: "edit", input: { path: "c.yaml", edits: [{ oldText: "a", newText: "b" }] } }), undefined);
});

test("a commit that stages a secret is blocked; a clean one goes through", async () => {
	const dir = repo();
	const m = await load(dir);
	writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
	run(dir, "add", "b.ts");
	assert.equal(await m.bash("git commit -m 'add b'"), undefined);

	writeFileSync(join(dir, "c.ts"), `const key = "${FAKE.aws}";\n`);
	run(dir, "add", "c.ts");
	const r = await m.bash("git commit -m 'add c'");
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /c\.ts:1 — AWS access key/);
});

test("git add <path> && git commit looks only at that path; -A looks at everything", async () => {
	const dir = repo();
	const m = await load(dir);
	writeFileSync(join(dir, "clean.ts"), "export const ok = 1;\n");
	writeFileSync(join(dir, "scratch.md"), `token ${FAKE.github}\n`);
	assert.equal(await m.bash("git add clean.ts && git commit -m clean"), undefined, "an unrelated untracked file does not block");
	assert.equal((await m.bash("git add -A && git commit -m all"))?.block, true);
	assert.equal((await m.bash("git add scratch.md && git commit -m s"))?.block, true);
});

test("commit && push checks the new commit, not only the history already in HEAD", async () => {
	const dir = repo();
	const m = await load(dir);
	writeFileSync(join(dir, "a.txt"), `hello ${FAKE.aws}\n`);
	const r = await m.bash("git commit -am x && git push");
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /a\.txt:1 — AWS access key/);
});

test("a push scans every commit, so a secret added and later removed is still caught", async () => {
	const dir = repo();
	const m = await load(dir);
	writeFileSync(join(dir, "config.ts"), `const t = "${FAKE.github}";\n`);
	run(dir, "add", "config.ts");
	run(dir, "commit", "-qm", "add");
	writeFileSync(join(dir, "config.ts"), "const t = process.env.T;\n");
	run(dir, "commit", "-qam", "remove");
	const r = await m.bash("git push origin main");
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /rewrite the commits/);
});

test("push uses git -C and cd ~/..., and the commit from a subdirectory sees untracked files at the root", async () => {
	const dir = repo();
	const m = await load(HERE);
	writeFileSync(join(dir, ".env"), "TOKEN=1\n");
	run(dir, "add", "-f", ".env");
	run(dir, "commit", "-qm", "oops");
	const push = await m.bash(`git -C ${dir} push origin main`);
	assert.equal(push?.block, true);
	assert.match(String(push?.reason), /\.env — a file that usually holds secrets/);

	const sub = repo();
	mkdirSync(join(sub, "packages/x"), { recursive: true });
	writeFileSync(join(sub, "root.ts"), `const k = "${FAKE.aws}";\n`);
	const inSub = await load(join(sub, "packages/x"));
	assert.equal((await inSub.bash("git add -A && git commit -m all"))?.block, true);
});

test("when the check cannot run, the command is blocked rather than let through", async () => {
	const notRepo = mkdtempSync(join(tmpdir(), "secrets-norepo-"));
	dirs.push(notRepo);
	const m = await load(notRepo);
	const r = await m.bash("git push origin main");
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /could not check/);
});

test("other commands are not touched", async () => {
	const dir = repo();
	const m = await load(dir);
	assert.equal(await m.bash("git status"), undefined);
	unlinkSync(join(dir, "a.txt"));
	assert.equal(await m.bash("git log -p"), undefined);
});
