import assert from "node:assert/strict";
import { test } from "node:test";
import { readSession, similarity } from "./detect.ts";

let clock = 0;
const at = () => `2026-11-05T10:${String(clock++).padStart(2, "0")}:00.000Z`;
const header = (cwd = "/work/app") => JSON.stringify({ type: "session", cwd });
const user = (text: string) => JSON.stringify({ type: "message", timestamp: at(), message: { role: "user", content: [{ type: "text", text }] } });
const agent = (text: string, stopReason = "stop") =>
	JSON.stringify({ type: "message", timestamp: at(), message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
const blocked = (text: string) => JSON.stringify({ type: "message", timestamp: at(), message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text }] } });
const harness = (customType: string, text: string) => JSON.stringify({ type: "custom_message", customType, timestamp: at(), content: text });

const kinds = (lines: string[], since?: string) => readSession(lines, since).incidents.map((i) => i.kind);

test("pushback is found with the agent's words before it", () => {
	const r = readSession([header(), user("ログイン画面を直して"), agent("設定画面を直しました"), user("違う、ログイン画面だって言ったよね")]);
	assert.equal(r.cwd, "/work/app");
	assert.deepEqual(r.incidents.map((i) => [i.kind, i.before]), [["pushback", "設定画面を直しました"]]);
});

test("ordinary requests and questions are not pushback", () => {
	assert.deepEqual(kinds([header(), user("ROI っていつからのデータなのか見えないのなんでだろう"), user("表記をやめたい"), user("PR 作って")]), []);
});

test("short questions about progress are status checks; long ones are not", () => {
	assert.deepEqual(kinds([header(), user("コミットした？"), user("どこまで進んだ?"), user("イシューはクローズした？")]), ["status-check", "status-check", "status-check"]);
	assert.deepEqual(kinds([header(), user("このテストが失敗した原因を調べて、直せるなら直してほしい。どうして落ちた？")]), []);
});

test("a request repeated nearly word for word is asked again; short acknowledgements are not", () => {
	assert.deepEqual(kinds([header(), user("ROI の画面で開始日と終了日を指定できるようにして"), agent("…"), user("ROI の画面で開始日と終了日を指定できるようにしてよ")]), ["asked-again"]);
	assert.deepEqual(kinds([header(), user("お願いします"), agent("…"), user("お願いします")]), []);
});

test("an interrupted run carries the user's next message", () => {
	const r = readSession([header(), agent("全部読み直します", "aborted"), user("そこは読まなくていい、画面だけ見て")]);
	assert.deepEqual(r.incidents.map((i) => [i.kind, i.text]), [["interrupted", "そこは読まなくていい、画面だけ見て"]]);
});

test("the same block twice is a retry; once is not", () => {
	const twice = kinds([header(), blocked("Blocked by secrets: x\n- a"), blocked("Blocked by secrets: x\n- a")]);
	assert.deepEqual(twice, ["blocked-retry"]);
	assert.deepEqual(kinds([header(), blocked("Blocked by secrets: x"), blocked("Blocked by guard: y")]), []);
});

test("harness send-backs are found; per-request notes are not", () => {
	const lines = [
		header(),
		harness("reply", "[reply] Your last reply does not fit the reader yet."),
		harness("evidence", "[evidence] Before you finish, fix this in your reply."),
		harness("mandate", "[mandate] You are in do mode for this request, but your reply ends by asking for permission."),
		harness("mandate", "[mandate] This request starts in look mode"),
		harness("lens", "[lens] Today's card"),
	];
	assert.deepEqual(kinds(lines), ["sent-back", "sent-back", "sent-back"]);
});

test("since drops what was already reported, and user turns count only after it", () => {
	clock = 0;
	const lines = [header(), user("違う"), user("違うってば"), user("コミットした？")];
	const since = "2026-11-05T10:00:30.000Z";
	const r = readSession(lines, since);
	assert.deepEqual(r.incidents.map((i) => i.kind), ["pushback", "status-check"]);
	assert.equal(r.userTurns, 2);
});

test("broken lines are skipped", () => {
	assert.deepEqual(kinds([header(), "{not json", user("違う")]), ["pushback"]);
});

test("similarity tolerates small rewordings", () => {
	assert.ok(similarity("開始日と終了日を指定したい", "開始日と終了日を指定したいです") > 0.8);
	assert.ok(similarity("開始日を指定したい", "favicon を作って") < 0.3);
});
