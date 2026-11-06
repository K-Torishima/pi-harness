/**
 * Pure checks for reply: does a finished reply fit the person reading it?
 * Only clear, mechanical problems are flagged; taste is left to the model. No pi imports, so tests can load it directly.
 */

// Past these, a reply counts as too long, unless the user asked for detail. Code blocks do not count
export const MAX_CHARS = 600;
export const MAX_LINES = 15;

const JAPANESE = /[぀-ヿ一-鿿]/g;
const LETTERS = /[A-Za-z぀-ヿ一-鿿]/g;

/** Share of letters that are Japanese, from 0 to 1 */
export function japaneseShare(text: string): number {
	const letters = text.match(LETTERS)?.length ?? 0;
	return letters === 0 ? 0 : (text.match(JAPANESE)?.length ?? 0) / letters;
}

/** Did the user ask for a long or complete answer? */
export function asksForDetail(userText: string): boolean {
	return (
		/詳しく|詳細|全部|全て|すべて|一覧|列挙|洗い出|説明して|教えて.*(?:全|詳)|\b(?:in detail|details?|explain|everything|list all|full)\b/i.test(userText) ||
		// An explicit count asked for ("20 個出して", "list 10 ideas"). A line number in an error message is not one
		/\d+\s*(?:個|件|点|項目|案|つ)(?:ほど|くらい|ぐらい)?\s*(?:の\S{0,12}?)?(?:を|は)?\s*(?:出して|挙げて|書いて|教えて|考えて|ほしい|欲しい|リスト|列挙)/.test(userText) ||
		/\b(?:give|list|write|suggest|show)\s+(?:me\s+)?\d+\s+(?:\w+\s+)?(?:items?|points?|ideas?|ways?|examples?|options?)\b/i.test(userText)
	);
}

/** Did the user ask for the reply in English? */
export function asksForEnglish(userText: string): boolean {
	return /英語で|英文で|\bin english\b/i.test(userText);
}

const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "x");

// Openers that say nothing yet. "以下の 3 ファイルを直しました" or "I'll keep it" can be the conclusion, so they are not here
const PREAMBLE = /^(?:確認しました[。、！!]|承知しました|了解しました|かしこまりました|まず(?:は)?[、,]|結論から言うと|Let me\b|Sure[,!.]|Great[,!.]|Okay[,!.]|Certainly\b)/i;
// Words that make a #123 on the same line a color, not an issue
const COLOR = /色|カラー|colou?r|background|fill|stroke|border|rgb|hex|css|theme/i;

const REF = /(?<![\w/[#&])#(\d+)\b/g;
/**
 * A Japanese title right before the number ("起動方法整理 #157", "Crashlytics取得失敗 #43"), not a label or a particle
 * ("イシュー #3", "未完了は #43"). English puts verbs there ("I checked #39"), so only words with kanji or katakana count
 */
function titleBefore(text: string): boolean {
	const word = text.match(/([\p{L}\p{N}]+)\s?$/u)?.[1] ?? "";
	return /[\p{Script=Han}\p{Script=Katakana}]/u.test(word) && !/^(?:イシュー|プルリク|チケット)$/.test(word) && !/[のとはがをにでもへや]$/.test(word);
}
// "#1〜#9", "#117-#122": a range, named by the words around it ("親Issue #1〜#9")
const RANGE = /^\s?[〜~～\-–]\s?#\d|\d\s?[〜~～\-–]\s?$/;

/** Every #number the text mentions, and the ones it explains (with a link or a title right after) */
function refsIn(text: string): { all: string[]; explained: Set<string> } {
	const all: string[] = [];
	const explained = new Set<string>();
	for (const m of text.matchAll(REF)) {
		const n = m[1];
		const at = m.index ?? 0;
		// #333 or #000000 next to a word about color is a color
		const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at) === -1 ? undefined : text.indexOf("\n", at));
		if ([3, 4, 6, 8].includes(n.length) && COLOR.test(line)) continue;
		const before = text.slice(Math.max(0, at - 3), at);
		const after = text.slice(at + m[0].length, at + m[0].length + 4);
		const linked = before.endsWith("[") || new RegExp(`/(?:issues|pull)/${n}\\b`).test(text);
		const titled = /^(?:「|（|\s?\(|:\s?\S|：|\s[—–-]\s)/.test(after) || titleBefore(text.slice(Math.max(0, at - 16), at));
		if (linked || titled || RANGE.test(after) || RANGE.test(before)) explained.add(n);
		if (!all.includes(n)) all.push(n);
	}
	// A link to it, such as [#43](…/issues/43)
	for (const m of text.matchAll(/\/(?:issues|pull)\/(\d+)\b/g)) explained.add(m[1]);
	return { all, explained };
}

/**
 * Issue or PR numbers mentioned without saying what they are. A number counts as explained when the reply explains it
 * anywhere, when it is part of a range, when the user wrote it, or when an earlier reply explained it
 */
function bareRefs(text: string, userText: string, earlier: string): string[] {
	const { all, explained } = refsIn(text);
	const known = new Set([...refsIn(userText).all, ...refsIn(earlier).explained]);
	return all.filter((n) => !explained.has(n) && !known.has(n)).map((n) => `#${n}`);
}

/** "A or B?" style choices whose letters are never spelled out */
function bareOptions(text: string): boolean {
	// "A/B テスト" and "A/B testing" name a method, not a choice
	const mentions = /(?:^|[\s（(「])([A-C])(?:案)?\s*(?:と|か|or|\/|、)\s*([A-C])(?:案)?(?![A-Za-z])(?!\s*(?:テスト|test))/im.test(text);
	// "A. ...", "- A: ...", "**A**: ...", "- **A案**：..."
	const defined = /^\s*(?:[-*]\s*)?(?:\*\*)?[(（]?[A-C](?:案)?(?:\*\*)?\s*[.:)）：]/m.test(text);
	return mentions && !defined;
}

/**
 * What is wrong with a finished reply, as instructions for rewriting it. Empty when it is fine.
 * `earlier` is the text of earlier replies in the conversation, where a #number may already have been explained
 */
export function checkReply(reply: string, userText: string, earlier = ""): string[] {
	const problems: string[] = [];
	const text = reply.trim();
	if (!text) return problems;
	const prose = withoutCode(text);

	if (japaneseShare(userText) >= 0.3 && !asksForEnglish(userText) && japaneseShare(prose) < 0.15 && prose.length > 40) {
		problems.push("It is written in English, but the user writes in Japanese. Reply in Japanese.");
	}
	if (!asksForDetail(userText)) {
		const lines = prose.split("\n").filter((l) => l.trim()).length;
		if (prose.length > MAX_CHARS || lines > MAX_LINES) {
			problems.push(
				`It is too long (${prose.length} characters, ${lines} lines; aim for under ${MAX_CHARS} and ${MAX_LINES}). Lead with the conclusion, keep at most 3 points, and end with one line naming the details you left out.`,
			);
		}
	}
	const refs = bareRefs(prose, userText, earlier);
	if (refs.length > 0) problems.push(`It mentions ${refs.join(", ")} by number only. Say what each one is (its title, or a link).`);
	if (bareOptions(prose)) problems.push("It asks the user to choose between letters (A / B) without saying what each one is. Spell the options out.");
	const first = prose.split("\n").find((l) => l.trim()) ?? "";
	if (PREAMBLE.test(first.trim())) problems.push("The first line is a preamble. Start with the conclusion or the answer.");
	return problems;
}
