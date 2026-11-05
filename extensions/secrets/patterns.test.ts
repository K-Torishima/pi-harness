import assert from "node:assert/strict";
import { test } from "node:test";
import { FAKE } from "../../test/fake-secrets.ts";
import { addScope, commandDir, outgoingActions, redact, scanDiff } from "./patterns.ts";

test("redact hides every kind of secret and says what it hid", () => {
	const text = `token=${FAKE.github}\naws ${FAKE.aws}\n${FAKE.key}\nslack ${FAKE.slack} and ${FAKE.anthropic} ${FAKE.npm}`;
	const r = redact(text);
	for (const v of Object.values(FAKE)) assert.ok(!r.text.includes(v), v.slice(0, 12));
	assert.deepEqual(new Set(r.found), new Set(["GitHub token", "AWS access key", "private key", "Slack token", "API key", "npm token"]));
	assert.match(r.text, /\[redacted GitHub token\]/);
	assert.match(r.text, /\[redacted private key\]\nslack/, "the key ends at END; the text after it stays");
});

test("redact leaves ordinary text alone, including code that checks for a key header", () => {
	const text = "const token = process.env.GITHUB_TOKEN; // sk-learn is a library\nAKIA is a prefix";
	assert.deepEqual(redact(text), { text, found: [] });
	const code = ['if (pem.startsWith("-----BEGIN PRIVATE', ' KEY-----")) {', "\n  return parse(pem);\n}\nexport const rest = 1;"].join("");
	assert.deepEqual(redact(code), { text: code, found: [] });
});

test("a key body cut off without END is still hidden", () => {
	const cut = FAKE.key.split("\n").slice(0, 2).join("\n");
	assert.equal(redact(`${cut}\n`).found.length, 1);
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

test("test files may hold made-up passwords, but not real key shapes", () => {
	const made = ['pass', 'word: "private-password"'].join("");
	for (const file of ["src/a/__tests__/monitoring.test.ts", "src/a.spec.tsx", "test/helpers.ts", "fixtures/login.json"]) {
		assert.deepEqual(scanDiff(diff(file, made)), [], file);
	}
	assert.equal(scanDiff(diff("src/login.ts", made)).length, 1, "outside tests it still counts");
	assert.equal(scanDiff(diff("src/a/__tests__/x.test.ts", `const t = "${FAKE.github}";`))[0].what, "GitHub token");
});

test("scanDiff catches personal details", () => {
	const personal = { homeDir: "/home/someone", emails: ["someone@example.org"], terms: ["secret-client"] };
	const found = scanDiff(diff("README.md", "run /home/someone/work/x", "mail someone@example.org", "for secret-client"), personal).map((f) => f.what);
	assert.deepEqual(found, ["absolute path under your home directory", "personal email address", 'private term "secret-client"']);
	assert.deepEqual(scanDiff(diff("README.md", "see ~/work"), personal), [], "~ paths are fine");
});

test("secret files count when lines are added, once per file, not when lines are removed", () => {
	assert.deepEqual(scanDiff(diff(".env", "A=1", "B=2")), [{ file: ".env", line: 0, what: "a file that usually holds secrets" }]);
	assert.equal(scanDiff(diff("config/.env.production", "A=1"))[0].what, "a file that usually holds secrets");
	assert.deepEqual(scanDiff(diff(".env.example", "A=")), []);
	assert.deepEqual(scanDiff(diff(".npmrc", "registry=https://registry.npmjs.org/")), []);
	const removal = ["+++ b/.env.development", "@@ -2,1 +2,0 @@", "-LEAKED=1"].join("\n");
	assert.deepEqual(scanDiff(removal), [], "removing a leaked line is the fix, not a leak");
});

test("outgoingActions finds every outgoing action in a command", () => {
	assert.deepEqual(outgoingActions("git add -A && git commit -m 'x'"), ["commit"]);
	assert.deepEqual(outgoingActions("git commit -am x && git push"), ["commit", "push"]);
	assert.deepEqual(outgoingActions("git -C repo push -u origin feat"), ["push"]);
	assert.deepEqual(outgoingActions("git --no-pager push"), ["push"]);
	assert.deepEqual(outgoingActions('bash -c "git push"'), ["push"]);
	assert.deepEqual(outgoingActions("gh pr create --fill"), ["pr"]);
	assert.deepEqual(outgoingActions("git commit -m 'before git push'"), ["commit"]);
	assert.deepEqual(outgoingActions("git commit -F- <<'EOF'\nfix: run before git push\nEOF"), ["commit"]);
	assert.deepEqual(outgoingActions("git log --grep 'commit'"), []);
	assert.deepEqual(outgoingActions('rg "git push" docs'), []);
});

test("addScope reads what a commit takes in besides the index", () => {
	assert.deepEqual(addScope("git commit -m x"), { all: false, paths: [] });
	assert.deepEqual(addScope("git add src/a.ts lib && git commit -m x"), { all: false, paths: ["src/a.ts", "lib"] });
	assert.deepEqual(addScope("git add -A && git commit -m x"), { all: true, paths: [] });
	assert.deepEqual(addScope("git commit -am 'x'"), { all: true, paths: [] });
	assert.deepEqual(addScope("git commit --amend -m x"), { all: false, paths: [] });
});

test("commandDir reads git -C and a leading cd, expanding ~", () => {
	assert.equal(commandDir("git -C ../other commit -m x", "/h"), "../other");
	assert.equal(commandDir("cd 'my repo' && git push", "/h"), "my repo");
	assert.equal(commandDir("cd ~/repo && git push", "/h"), "/h/repo");
	assert.equal(commandDir("git -C $HOME/repo push", "/h"), "/h/repo");
	assert.equal(commandDir("git push", "/h"), undefined);
});
