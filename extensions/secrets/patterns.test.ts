import assert from "node:assert/strict";
import { test } from "node:test";
import { FAKE } from "../../test/fake-secrets.ts";
import { commandDir, outgoingAction, redact, scanDiff } from "./patterns.ts";

test("redact hides every kind of secret and says what it hid", () => {
	const text = `token=${FAKE.github}\naws ${FAKE.aws}\n${FAKE.key}\nslack ${FAKE.slack} and ${FAKE.anthropic}`;
	const r = redact(text);
	for (const v of Object.values(FAKE)) assert.ok(!r.text.includes(v), v.slice(0, 12));
	assert.deepEqual(new Set(r.found), new Set(["GitHub token", "AWS access key", "private key", "Slack token", "API key"]));
	assert.match(r.text, /\[redacted GitHub token\]/);
});

test("redact leaves ordinary text alone", () => {
	const text = "const token = process.env.GITHUB_TOKEN; // sk-learn is a library\nAKIA is a prefix";
	assert.deepEqual(redact(text), { text, found: [] });
});

const diff = (file: string, ...added: string[]) => [`+++ b/${file}`, `@@ -0,0 +10,${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n");

test("scanDiff reports secrets with file and line", () => {
	const findings = scanDiff(diff("src/a.ts", "const ok = 1;", `const t = "${FAKE.github}";`, `const token = "${FAKE.github}";`));
	assert.deepEqual(findings, [
		{ file: "src/a.ts", line: 11, what: "GitHub token" },
		{ file: "src/a.ts", line: 12, what: "GitHub token" },
		{ file: "src/a.ts", line: 12, what: "hard-coded secret value" },
	]);
});

test("scanDiff ignores removed lines and placeholders", () => {
	const removed = ["+++ b/a.ts", "@@ -3,1 +3,0 @@", `-const t = "${FAKE.github}";`].join("\n");
	assert.deepEqual(scanDiff(removed), []);
	assert.deepEqual(scanDiff(diff("a.ts", 'api_key: "your-api-key-here"', 'password = "${DB_PASSWORD_VALUE}"')), []);
	assert.equal(scanDiff(diff("a.ts", ["pass", 'word = "hunter2-but-longer"'].join(""))).length, 1);
});

test("scanDiff catches personal details and secret files", () => {
	const personal = { homeDir: "/home/someone", emails: ["someone@example.org"], terms: ["secret-client"] };
	const found = scanDiff(diff("README.md", "run /home/someone/work/x", "mail someone@example.org", "for secret-client"), personal).map((f) => f.what);
	assert.deepEqual(found, ["absolute path under your home directory", "personal email address", 'private term "secret-client"']);
	assert.equal(scanDiff(diff(".env", "A=1"))[0].what, "a file that usually holds secrets");
	assert.equal(scanDiff(diff("config/.env.production", "A=1"))[0].what, "a file that usually holds secrets");
	assert.deepEqual(scanDiff(diff(".env.example", "A=")), []);
	assert.deepEqual(scanDiff(diff("README.md", "see ~/work"), personal), [], "~ paths are fine");
});

test("outgoingAction finds commit, push, and PR", () => {
	assert.equal(outgoingAction("git add -A && git commit -m 'x'"), "commit");
	assert.equal(outgoingAction("git -C repo push -u origin feat"), "push");
	assert.equal(outgoingAction("git --no-pager push"), "push");
	assert.equal(outgoingAction("gh pr create --fill"), "pr");
	assert.equal(outgoingAction("git commit -m 'before git push'"), "commit");
	assert.equal(outgoingAction("git log --grep 'commit'"), undefined);
	assert.equal(outgoingAction('rg "git push" docs'), undefined);
});

test("commandDir reads git -C and a leading cd", () => {
	assert.equal(commandDir("git -C ../other commit -m x"), "../other");
	assert.equal(commandDir("cd 'my repo' && git push"), "my repo");
	assert.equal(commandDir("git push"), undefined);
});
