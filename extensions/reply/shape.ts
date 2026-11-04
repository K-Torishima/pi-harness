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
		// An explicit count ("20 個", "10 points") asks for that much
		/\d+\s*(?:個|件|点|行|項目|案|\s?(?:items?|points?|ideas?|lines?))/i.test(userText)
	);
}

/** Did the user ask for the reply in English? */
export function asksForEnglish(userText: string): boolean {
	return /英語で|英文で|\bin english\b/i.test(userText);
}

const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "x");

const PREAMBLE = /^(?:確認しました|承知しました|了解しました|かしこまりました|まず(?:は)?[、,]|以下(?:に|の|で)|結論から言うと|Let me\b|Sure[,!.]|Great[,!.]|Okay[,!.]|Certainly\b|I'll\b)/i;

/** Issue or PR numbers mentioned without saying what they are */
function bareRefs(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?<![\w/[#&])#(\d+)\b/g)) {
		const n = m[1];
		const before = text.slice(Math.max(0, (m.index ?? 0) - 1), m.index);
		const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 3);
		const linked = before === "[" || new RegExp(`/(?:issues|pull)/${n}\\b`).test(text);
		const titled = /^(?:「|（|\s?\(|:\s?\S|：|\s[—–-]\s)/.test(after);
		if (!linked && !titled && !out.includes(`#${n}`)) out.push(`#${n}`);
	}
	return out;
}

/** "A or B?" style choices whose letters are never spelled out */
function bareOptions(text: string): boolean {
	const mentions = /(?:^|[\s（(「])([A-C])(?:案)?\s*(?:と|か|or|\/|、)\s*([A-C])(?:案)?(?![A-Za-z])/m.test(text);
	const defined = /^\s*(?:[-*]\s*|\*\*)?[(（]?[A-C](?:案)?[.:)）：]/m.test(text);
	return mentions && !defined;
}

/** What is wrong with a finished reply, as instructions for rewriting it. Empty when it is fine */
export function checkReply(reply: string, userText: string): string[] {
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
	const refs = bareRefs(prose);
	if (refs.length > 0) problems.push(`It mentions ${refs.join(", ")} by number only. Say what each one is (its title, or a link).`);
	if (bareOptions(prose)) problems.push("It asks the user to choose between letters (A / B) without saying what each one is. Spell the options out.");
	const first = prose.split("\n").find((l) => l.trim()) ?? "";
	if (PREAMBLE.test(first.trim())) problems.push("The first line is a preamble. Start with the conclusion or the answer.");
	return problems;
}
