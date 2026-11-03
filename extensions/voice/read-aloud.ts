/**
 * Read aloud: speak text with the same voice as the Alora app (VOICEVOX CORE + Nemo)
 *
 * Alora itself is not launched. We drive its bundled voice helper, AloraVoice, directly.
 *   Request: one line of {"op":"synthesize","text":"…","speaker":N,"speed":X}
 *   Response: one line of {"ok":true,"length":N} followed by N bytes of WAV
 * Voice and speed come from Alora's settings (builtInVoiceID / speechSpeed).
 * If AloraVoice is not installed, fall back to macOS `say`.
 *
 * Text cleanup and splitting follow the same rules as Alora's SpeechText.
 * The next sentence is synthesized while the current one is playing.
 */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALORA_APP = "/Applications/Alora.app/Contents";
const VOICE_HELPER = join(ALORA_APP, "MacOS", "AloraVoice");
const VOICEVOX_DIR = join(ALORA_APP, "Resources", "VOICEVOX");
const IDLE_EXIT_MS = 5 * 60 * 1000;

// --- Text cleanup (same as Alora's SpeechText) ---
// The replacement words are Japanese on purpose: they are spoken by a Japanese voice.

const RULES: [RegExp, string][] = [
	[/^\s*```[\s\S]*?^\s*```[^\n]*$/gm, "（コード省略）"],
	[/^\s*```.*$/gm, ""],
	[/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*(?::?-{3,}:?)?[ \t]*$/gm, ""],
	[/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, ""],
	[/\[([^\]]*)\]\([^)]*\)/g, "$1"],
	[/https?:\/\/\S+/g, "リンク"],
	[/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, ""],
	[/[ \t]*\|[ \t]*/g, "、"],
	[/[*_`~]+/g, ""],
];

export function cleanForSpeech(text: string): string {
	let result = text;
	for (const [re, to] of RULES) result = result.replace(re, to);
	return result.trim();
}

export function sentences(text: string): string[] {
	const out: string[] = [];
	let current = "";
	for (const ch of text) {
		if (ch === "\n" || ch === "\r") {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
		if ("。！？!?".includes(ch)) {
			out.push(current);
			current = "";
		}
	}
	out.push(current);
	return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split long sentences after commas into chunks of about maxLength characters (less silence while synthesizing). */
export function splitLong(sentence: string, maxLength = 60): string[] {
	if ([...sentence].length <= maxLength) return [sentence];
	const clauses: string[] = [];
	let clause = "";
	for (const ch of sentence) {
		clause += ch;
		if ("、，,；;：:".includes(ch)) {
			clauses.push(clause);
			clause = "";
		}
	}
	if (clause) clauses.push(clause);
	const pieces: string[] = [];
	let piece = "";
	for (const c of clauses) {
		if (piece && [...piece].length + [...c].length > maxLength) {
			pieces.push(piece);
			piece = "";
		}
		piece += c;
	}
	if (piece) pieces.push(piece);
	return pieces.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function speechPieces(text: string): string[] {
	return sentences(cleanForSpeech(text)).flatMap((s) => splitLong(s));
}

// --- Alora settings ---
// PI_VOICE_DEFAULTS_DOMAIN points at a different defaults domain if your copy of the app uses one.
const DEFAULTS_DOMAIN = process.env.PI_VOICE_DEFAULTS_DOMAIN ?? "com.ktorishima.alora";

function aloraDefault(key: string): string | undefined {
	try {
		return execFileSync("defaults", ["read", DEFAULTS_DOMAIN, key], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

// --- Voice helper ---

class VoiceHelper {
	private proc?: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private pending: { resolve: (wav: Buffer) => void; reject: (e: Error) => void }[] = [];
	private header?: { ok: boolean; length?: number; error?: string };
	private idleTimer?: ReturnType<typeof setTimeout>;

	static available(): boolean {
		return existsSync(VOICE_HELPER) && VoiceHelper.onnxruntime() !== undefined;
	}

	private static onnxruntime(): string | undefined {
		try {
			const dir = join(ALORA_APP, "Frameworks");
			const name = readdirSync(dir).find((f) => /^libvoicevox_onnxruntime.*\.dylib$/.test(f));
			return name ? join(dir, name) : undefined;
		} catch {
			return undefined;
		}
	}

	private ensure(): ChildProcessWithoutNullStreams {
		if (this.proc && this.proc.exitCode === null) return this.proc;
		const dict = readdirSync(VOICEVOX_DIR).find((f) => f.startsWith("open_jtalk_dic"));
		const proc = spawn(
			VOICE_HELPER,
			[VoiceHelper.onnxruntime()!, join(VOICEVOX_DIR, dict ?? ""), join(VOICEVOX_DIR, "n0.vvm")],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		this.proc = proc;
		this.buffer = Buffer.alloc(0);
		this.header = undefined;
		proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.drain();
		});
		const failAll = (msg: string) => {
			for (const p of this.pending.splice(0)) p.reject(new Error(msg));
		};
		proc.on("error", (e) => failAll(e.message));
		proc.on("exit", () => {
			if (this.proc === proc) this.proc = undefined;
			failAll("The voice helper exited");
		});
		return proc;
	}

	private drain() {
		while (true) {
			if (!this.header) {
				const nl = this.buffer.indexOf(0x0a);
				if (nl < 0) return;
				try {
					this.header = JSON.parse(this.buffer.subarray(0, nl).toString("utf8"));
				} catch {
					this.header = { ok: false, error: "Could not read the response" };
				}
				this.buffer = this.buffer.subarray(nl + 1);
			}
			const h = this.header!;
			const length = h.ok ? (h.length ?? 0) : 0;
			if (this.buffer.length < length) return;
			const payload = this.buffer.subarray(0, length);
			this.buffer = this.buffer.subarray(length);
			this.header = undefined;
			const p = this.pending.shift();
			if (!p) continue;
			if (h.ok) p.resolve(Buffer.from(payload));
			else p.reject(new Error(h.error ?? "Synthesis failed"));
		}
	}

	private request(body: object): Promise<Buffer> {
		const proc = this.ensure();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		// Exit after 5 idle minutes to give the memory back (same as Alora)
		this.idleTimer = setTimeout(() => this.close(), IDLE_EXIT_MS);
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			proc.stdin.write(`${JSON.stringify(body)}\n`);
		});
	}

	synthesize(text: string, speaker: number, speed: number): Promise<Buffer> {
		return this.request({ op: "synthesize", text, speaker, speed });
	}

	/** ID of the first voice (style) in the voice model */
	async firstVoiceID(): Promise<number> {
		const metas = JSON.parse((await this.request({ op: "voices" })).toString("utf8")) as {
			styles: { id: number }[];
		}[];
		const id = metas[0]?.styles[0]?.id;
		if (id === undefined) throw new Error("No voice found");
		return id;
	}

	close() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.proc?.stdin.end();
		this.proc = undefined;
	}
}

// --- Reading aloud ---

export class ReadAloud {
	private helper = new VoiceHelper();
	private player?: ReturnType<typeof spawn>;
	private generation = 0;
	private tmp?: string;
	reading = false;

	/** Read the text. Resolves when it finishes or stop() is called. */
	async read(text: string, onError: (message: string) => void): Promise<void> {
		this.stop();
		const pieces = speechPieces(text);
		if (pieces.length === 0) return;
		const gen = ++this.generation;
		this.reading = true;
		try {
			if (VoiceHelper.available()) await this.readWithVoicevox(pieces, gen);
			else await this.readWithSay(pieces.join("\n"), gen);
		} catch (e) {
			if (gen === this.generation) onError((e as Error).message);
		} finally {
			if (gen === this.generation) this.reading = false;
		}
	}

	stop() {
		this.generation++;
		this.reading = false;
		this.player?.kill();
		this.player = undefined;
	}

	dispose() {
		this.stop();
		this.helper.close();
		if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
	}

	private async readWithVoicevox(pieces: string[], gen: number) {
		// Like Alora, use the first voice when builtInVoiceID is not set
		const saved = aloraDefault("builtInVoiceID");
		const speaker =
			saved !== undefined && Number.isInteger(Number(saved)) ? Number(saved) : await this.helper.firstVoiceID();
		const speed = Number(aloraDefault("speechSpeed") ?? "") || 1.0;
		if (!this.tmp) this.tmp = mkdtempSync(join(tmpdir(), "pi-voice-"));

		// Synthesize the next piece while the current one plays
		let next = this.helper.synthesize(pieces[0], speaker, speed);
		for (let i = 0; i < pieces.length; i++) {
			const wav = await next;
			if (gen !== this.generation) return;
			if (i + 1 < pieces.length) next = this.helper.synthesize(pieces[i + 1], speaker, speed);
			const file = join(this.tmp, `${i % 2}.wav`);
			writeFileSync(file, wav);
			await this.play("afplay", [file], gen);
			if (gen !== this.generation) return;
		}
	}

	private async readWithSay(text: string, gen: number) {
		await this.play("say", [text], gen);
	}

	private play(cmd: string, args: string[], gen: number): Promise<void> {
		return new Promise((resolve) => {
			if (gen !== this.generation) return resolve();
			const p = spawn(cmd, args, { stdio: "ignore" });
			this.player = p;
			p.on("exit", () => resolve());
			p.on("error", () => resolve());
		});
	}
}
