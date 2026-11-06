import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOAL_KICKOFF, readSession, similarity } from "./detect.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

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

test("pasted text and neutral questions are not pushback", () => {
	const pasted = `エラーが出た\n${"x".repeat(200)}\n期待値と違う`;
	assert.deepEqual(kinds([header(), user(pasted), user("このループ何回回る？")]), []);
	assert.deepEqual(kinds([header(), user("何回も言ってるけど")]), ["pushback"]);
	assert.deepEqual(kinds([header(), user("warpとかOrcaなどのエディタと体験が明らかに違うものとかありますか？"), user("勝手に調べていいよ")]), [], "a difference, and a go-ahead");
	for (const text of ["勝手にコミットしないで", "全然違うところ直してる", "違うことしないで", "勝手に変更しないで、確認してください", "勝手にpushしてOKとは言ってない"])
		assert.deepEqual(kinds([header(), user(text)]), ["pushback"], text);
});

test("the /goal kickoff is not a user turn and never counts as asked again", () => {
	const kickoff = (goal: string) => `Goal: ${goal}\n\n${GOAL_KICKOFF} How to proceed:\n1. First, …`;
	const r = readSession([header(), user(kickoff("テストを足す")), agent("…"), user(kickoff("README を直す"))]);
	assert.deepEqual([r.userTurns, r.incidents], [0, []]);
	assert.ok(readFileSync(join(HERE, "../../extensions/goal/index.ts"), "utf8").includes(GOAL_KICKOFF), "goal still sends this line");
});

test("an interrupt with no message yet waits for the next run, where its reason shows", () => {
	clock = 0;
	const lines = [header(), agent("全部読み直します", "aborted")];
	assert.deepEqual(kinds(lines), []);
	const later = [...lines, user("画面だけ見て")];
	const r = readSession(later, "2026-11-05T10:00:30.000Z");
	assert.deepEqual(r.incidents.map((i) => [i.kind, i.text, i.before]), [["interrupted", "画面だけ見て", "全部読み直します"]]);
});

test("a block repeated after the last run is reported, once, with its count", () => {
	clock = 0;
	const lines = [header(), blocked("Blocked by guard: rm"), blocked("Blocked by guard: rm"), blocked("Blocked by guard: rm")];
	assert.deepEqual(readSession(lines).incidents.map((i) => i.text), ["3× Blocked by guard: rm"]);
	assert.deepEqual(readSession(lines, "2026-11-05T10:00:30.000Z").incidents.map((i) => i.text), ["3× Blocked by guard: rm"]);
});

test("a send-back is found by its mark whatever it says; reply, evidence, and mandate set the mark", () => {
	const marked = JSON.stringify({ type: "custom_message", customType: "mandate", timestamp: at(), content: "[mandate] reworded", details: { sentBack: true } });
	assert.deepEqual(kinds([header(), marked]), ["sent-back"]);
	for (const ext of ["reply", "evidence", "mandate"]) {
		assert.match(readFileSync(join(HERE, `../../extensions/${ext}/index.ts`), "utf8"), /details: \{ sentBack: true \}/, ext);
	}
});

test("broken lines are skipped", () => {
	assert.deepEqual(kinds([header(), "{not json", user("違う")]), ["pushback"]);
});

test("similarity tolerates small rewordings", () => {
	assert.ok(similarity("開始日と終了日を指定したい", "開始日と終了日を指定したいです") > 0.8);
	assert.ok(similarity("開始日を指定したい", "favicon を作って") < 0.3);
});
