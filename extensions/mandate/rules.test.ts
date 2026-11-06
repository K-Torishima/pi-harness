import assert from "node:assert/strict";
import { test } from "node:test";
import { asksOutward, asksPermission, outwardAsks, blamesMode, classifyCommand, classifyTool, localChanges, quoteMatches } from "./rules.ts";

test("localChanges lists every changing part of a command, not just the first", () => {
	assert.deepEqual(
		localChanges("git add -A && sed -i 's/a/b/' x.ts > out.txt").map((c) => c.label),
		["git (write)", "in-place edit"],
	);
	assert.deepEqual(localChanges("ls && cat a > b").map((c) => c.label), ["write to a file with >"]);
	assert.deepEqual(localChanges("git status && rg foo"), []);
});

const kind = (cmd: string) => classifyCommand(cmd).kind;
const grant = (cmd: string) => {
	const e = classifyCommand(cmd);
	return e.kind === "outward" ? e.grant : undefined;
};

test("read-only commands stay read", () => {
	for (const cmd of [
		"ls -la",
		"git status --short",
		"git log --oneline | head -3",
		"git diff --cached",
		"git branch -a",
		"git stash list",
		"git tag -l",
		"git worktree list",
		'rg "rm -rf" src',
		"jq '.a > 1' data.json",
		"grep -n foo file 2>/dev/null",
		"npm test 2>&1 | tail",
		"gh pr view 12 --json title",
		"gh issue list --limit 5",
		"gh api repos/o/r/pulls",
		"gh api graphql -f query='{ viewer { login } }'",
		"curl -s https://example.com",
		"cat <<'EOF'\nrm -rf / and git push\nEOF",
		"node --test extensions/**/*.test.ts",
	]) {
		assert.equal(kind(cmd), "read", cmd);
	}
});

test("local changes are detected", () => {
	for (const cmd of [
		"rm foo.txt",
		"mkdir -p out && touch out/a",
		"cd src && mv a.ts b.ts",
		"echo hi > notes.md",
		"cat a >> b",
		"sed -i '' 's/a/b/' file",
		"git add -A",
		"git commit -m 'fix push handling'",
		"git checkout -b feat/x",
		"git stash",
		"git -C ../repo reset --soft HEAD~1",
		"npm install lodash",
		"pip install requests",
		"find . -name '*.tmp' | xargs rm",
		"cat > out.txt <<EOF\nhello\nEOF",
	]) {
		assert.equal(kind(cmd), "local", cmd);
	}
});

test("outward actions map to their grant", () => {
	assert.equal(grant("git push origin main"), "push");
	assert.equal(grant("git -C repo push"), "push");
	assert.equal(grant("sh -c 'git push'"), "push");
	assert.equal(grant("gh pr create --fill"), "pr");
	assert.equal(grant("gh pr merge 3 --squash"), "pr");
	assert.equal(grant("gh issue comment 39 --body x"), "issue");
	assert.equal(grant("gh issue edit 175 --body-file b.md"), "issue");
	assert.equal(grant("npx wrangler deploy --env dev"), "deploy");
	assert.equal(grant("gh workflow run ci.yml"), "deploy");
	assert.equal(grant("gh api -X POST repos/o/r/issues -f title=x"), "api");
	assert.equal(grant("gh api repos/o/r/labels -f name=bug"), "api");
	assert.equal(grant("gh api graphql -f query='mutation { x }'"), "api");
	assert.equal(grant("curl -X POST https://hooks.slack.com/x -d '{}'"), "api");
	assert.equal(grant("curl --json '{}' https://api.example.com"), "api");
});

test("a commit message that mentions push is not a push", () => {
	assert.equal(kind("git commit -m 'stop the push loop'"), "local");
});

test("edit and write tools are local changes; others are read", () => {
	assert.equal(classifyTool("edit", { path: "a.ts" }).kind, "local");
	assert.equal(classifyTool("write", { path: "a.ts" }).kind, "local");
	assert.equal(classifyTool("read", { path: "a.ts" }).kind, "read");
	assert.equal(classifyTool("bash", { command: "git push" }).kind, "outward");
});

test("quotes must come from the user's message", () => {
	assert.ok(quoteMatches("実装して", "じゃあそれ実装して！"));
	assert.ok(quoteMatches("push して", "コミットしてpushして"));
	assert.ok(quoteMatches("ＯＫ、お願い", "ok、お願い"));
	assert.ok(quoteMatches("OK", "OK"), "a short message can be quoted whole");
	assert.ok(!quoteMatches("pushして", "コミットだけして"));
	assert.ok(!quoteMatches("", "anything"));
	assert.ok(!quoteMatches("。", "anything。"));
});

test("review regressions: quotes, git options, xargs, find, curl, gh api GET", () => {
	assert.equal(kind(`echo "it's" && rm -rf x && echo 'y'`), "local", "apostrophe inside double quotes");
	assert.equal(kind('git commit -m "docs: explain git push"'), "local", "push inside a commit message");
	assert.equal(kind('rg "gh pr create" src'), "read", "outward command inside a search string");
	assert.equal(grant("git --no-pager push"), "push");
	assert.equal(grant("git -c core.x=1 --git-dir=.git push origin"), "push");
	assert.equal(kind("git --no-pager log -3"), "read");
	assert.equal(kind("find . -name '*.tmp' | xargs -n 1 rm"), "local");
	assert.equal(kind("find . -name '*.tmp' -delete"), "local");
	assert.equal(kind("find . -name '*.ts' -exec rm {} +"), "local");
	assert.equal(kind("find . -name '*.ts' | xargs grep -n foo"), "read");
	assert.equal(grant("curl -sd x https://api.example.com"), "api");
	assert.equal(kind("curl -fsSL https://example.com/install.sh"), "read");
	assert.equal(kind("gh api -X GET search/issues -f q=repo:x"), "read");
	assert.equal(grant('bash -c "git push origin main"'), "push");
	assert.ok(!quoteMatches("を", "これを見て"), "one-character quote");
});

test("permission questions at the end of a reply are detected", () => {
	assert.ok(asksPermission("修正しました。次にテストを追加してよいですか？"));
	assert.ok(asksPermission("Done with step 1. Shall I continue with step 2?"));
	assert.ok(asksPermission("準備できました。進めますか？"));
	assert.ok(asksPermission("1つ目を直しました。次も進めてよいですか？"));
	assert.ok(asksPermission("コミットしても大丈夫ですか？"));
	assert.ok(asksPermission("pushしていい？"));
	assert.ok(asksPermission("よければ「進めて」と送ってください。"));
	assert.ok(!asksPermission("修正してテストも通りました。"));
	assert.ok(!asksPermission("A と B のどちらにしますか？"));
});

test("blamesMode spots a reply that held back because of the mode", () => {
	assert.ok(blamesMode("現在は読み取り専用（look）なので、変更していません。"));
	assert.ok(blamesMode("変更可能なモードになったら直します。"));
	assert.ok(blamesMode("I'm in look mode, so I did not change anything."));
	assert.ok(!blamesMode("ボリュームが read-only でマウントされているためです。"), "explaining read-only is not a stall");
	assert.ok(!blamesMode("末尾に改行を足しました。"));
	assert.ok(!blamesMode("The plan is to look at the logs first."), "plan and look as ordinary words");
});

test("git plumbing that only reads is read; git tag <name> is a change", () => {
	for (const c of ["git merge-base HEAD main", "git merge-tree --write-tree HEAD main", "git tag -l", "git tag --list 'v*'"]) assert.equal(classifyCommand(c).kind, "read", c);
	for (const c of ["git merge main", "git merge-file a b c", "git commit-tree HEAD^{tree} -m x", "git commit-graph write", "git tag v1.0", "git stash", "git branch -D x"]) assert.equal(classifyCommand(c).kind, "local", c);
});

test("asksOutward spots a closing question about an outward action", () => {
	// From a real session: closing issues is the user's call, so look mode must not send this back
	assert.ok(asksOutward("ログイン関連はまだ閉じていません。\nパスワード保存・自動再ログインは実装完了として閉じ、残る検証を親イシューで管理してよいですか？"));
	assert.ok(asksOutward("pushしていい？"));
	assert.ok(asksOutward("Shall I open the PR and merge it?"));
	assert.ok(!asksOutward("修正しました。次にテストを追加してよいですか？"));
	assert.ok(!asksOutward("本番の設定を読みました。次にテストを追加してよいですか？"), "only the question counts");
	for (const local of ["閉じ括弧を追加してよいですか？", "送信処理のバグを直してよいですか？", "公開APIの型を直してよいですか？", "mainにマージされた変更を読みました、次にテストを追加してよいですか？"])
		assert.ok(!asksOutward(local), local);
});

test("outwardAsks names the grant each outward question needs", () => {
	assert.deepEqual(outwardAsks("修正をGitHubへpushし、会社Macへ配備してよいですか？"), ["push", "deploy"]);
	assert.deepEqual(outwardAsks("カレンダーの読み取り権限を追加する認証を進めてよいですか？"), ["user"]);
	assert.deepEqual(outwardAsks("この session に Notion 接続を追加してよいですか？"), ["user"]);
	assert.deepEqual(outwardAsks("認証処理のテストを追加してよいですか？"), [], "local work on auth code");
});
