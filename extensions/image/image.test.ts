import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtension } from "../../test/load-extension.ts";
import { codexArgs, instruction, readEvents } from "./codex.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("codex runs read-only, without the user's config, with references attached", () => {
	const args = codexArgs("a fox", ["/a.png", "/b.png"]);
	assert.deepEqual(args.slice(0, 6), ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only"]);
	assert.deepEqual(args.slice(6, 10), ["-i", "/a.png", "-i", "/b.png"]);
	assert.equal(args[10], "--", "the prompt cannot be read as a flag");
	assert.match(args[11], /Request:\na fox$/);
	assert.match(instruction("x", 1), /attached image/);
	assert.doesNotMatch(instruction("x", 0), /attached image/);
});

test("readEvents finds the thread, the last message, and errors", () => {
	const lines = [
		'{"type":"thread.started","thread_id":"t-1"}',
		"not json",
		'{"type":"item.completed","item":{"type":"agent_message","text":"drawing\\n"}}',
		'{"type":"item.completed","item":{"type":"agent_message","text":"A fox. "}}',
	];
	assert.deepEqual(readEvents(lines.join("\n")), { threadId: "t-1", message: "A fox." });
	assert.equal(readEvents('{"type":"turn.failed","error":{"message":"quota"}}').error, "quota");
});

// A 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Put a fake codex on PATH that saves one PNG under CODEX_HOME, as the real one does */
function fakeCodex(saves: boolean) {
	const root = mkdtempSync(join(tmpdir(), "pi-image-"));
	const bin = join(root, "codex");
	writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = path.join(process.env.CODEX_HOME, "generated_images", "t-9");
if (${saves}) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "exec-1.png"), Buffer.from("${PNG}", "base64")); }
console.log(JSON.stringify({ type: "thread.started", thread_id: "t-9" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${saves} ? "A fox in snow." : "I cannot draw that." } }));
`,
	);
	chmodSync(bin, 0o755);
	process.env.PATH = `${root}:${process.env.PATH}`;
	process.env.CODEX_HOME = root;
	return root;
}

test("the image tool returns the saved file and shows the image", async () => {
	const root = fakeCodex(true);
	const m = await loadExtension(join(HERE, "index.ts"), root);
	const tool = m.ext.tools.get("image").definition;
	const r = await tool.execute("id", { prompt: "a fox" }, undefined, undefined, m.ctx);
	assert.equal(r.content[0].type, "text");
	assert.match(r.content[0].text, /Saved: .*t-9\/exec-1\.png\nA fox in snow\./);
	assert.equal(r.content[1].type, "image");
	assert.deepEqual(r.details.files, [join(root, "generated_images/t-9/exec-1.png")]);
});

test("when codex saves nothing, the tool says why", async () => {
	const root = fakeCodex(false);
	const m = await loadExtension(join(HERE, "index.ts"), root);
	const r = await m.ext.tools.get("image").definition.execute("id", { prompt: "a fox" }, undefined, undefined, m.ctx);
	assert.equal(r.content.length, 1);
	assert.match(r.content[0].text, /No image was generated: I cannot draw that\./);
});
