/** Drive secrets against real temporary git repositories */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { FAKE } from "../../test/fake-secrets.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
	dirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "bot@users.noreply.github.com");
	git("config", "user.name", "bot");
	writeFileSync(join(dir, "a.txt"), "hello\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return dir;
}
const run = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

test("secrets in tool output are hidden before the AI sees them", async () => {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	const r = await m.fire("tool_result", { toolName: "bash", content: [{ type: "text", text: `GITHUB_TOKEN=${FAKE.github}` }], isError: false });
	assert.deepEqual(r, { content: [{ type: "text", text: "GITHUB_TOKEN=[redacted GitHub token]" }] });
	assert.equal(await m.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "nothing here" }], isError: false }), undefined);
});

test("a commit that stages a secret is blocked; a clean one goes through", async () => {
	const dir = repo();
	const m = await loadExtension(join(HERE, "index.ts"), dir);
	writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
	run(dir, "add", "b.ts");
	assert.equal(await m.bash("git commit -m 'add b'"), undefined);

	writeFileSync(join(dir, "c.ts"), `const key = "${FAKE.aws}";\n`);
	run(dir, "add", "c.ts");
	const r = await m.bash("git commit -m 'add c'");
	assert.equal(r?.block, true);
	assert.match(String(r?.reason), /c\.ts:1 — AWS access key/);
});

test("git add && git commit looks at files not staged yet, including untracked ones", async () => {
	const dir = repo();
	const m = await loadExtension(join(HERE, "index.ts"), dir);
	writeFileSync(join(dir, "new.ts"), `const t = "${FAKE.github}";\n`);
	assert.equal(await m.bash("git commit -m only-staged"), undefined, "nothing staged yet");
	assert.equal((await m.bash("git add -A && git commit -m all"))?.block, true);
});

test("push and PR scan the commits that would leave, using git -C", async () => {
	const dir = repo();
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	writeFileSync(join(dir, ".env"), "TOKEN=1\n");
	run(dir, "add", "-f", ".env");
	run(dir, "commit", "-qm", "oops");
	const push = await m.bash(`git -C ${dir} push origin main`);
	assert.equal(push?.block, true);
	assert.match(String(push?.reason), /\.env — a file that usually holds secrets/);
	assert.match(String(push?.reason), /rewrite the commits/);
});

test("other commands are not touched", async () => {
	const m = await loadExtension(join(HERE, "index.ts"), HERE);
	assert.equal(await m.bash("git status"), undefined);
	assert.equal(await m.fire("tool_call", { toolName: "edit", input: { path: "a.ts" } }), undefined);
});
