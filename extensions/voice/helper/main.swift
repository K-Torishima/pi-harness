// pi-voice-helper: helper program for pi's voice input
//
// A trimmed-down version of the recording and recognition pipeline from the Alora app, usable from pi.
//   [AVAudioEngine] → [SpeechAnalyzer / DictationTranscriber ja-JP] → partial and final text → cleanup
//
// Usage
//   pi-voice-helper            Start recording from the microphone. Write "stop" to stdin to finish, "cancel" to discard
//   pi-voice-helper --file F   Transcribe the audio file F (for testing without a microphone)
//
// Writes one JSON object per line to stdout
//   {"type":"ready"}                 Recording started
//   {"type":"partial","text":"…"}    Progress (final + volatile text, cleaned up)
//   {"type":"final","text":"…"}      The whole final text (cleaned up). Exits after this
//   {"type":"error","message":"…"}   Failure. Exits after this
//
// The replacement dictionary is read from Alora's settings (the "replacements" key).
// Set PI_VOICE_DEFAULTS_DOMAIN to read it from a different defaults domain.

import AVFoundation
import Foundation
import Speech

// MARK: - Output

let outLock = NSLock()
func emit(_ object: [String: String]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  outLock.lock()
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  outLock.unlock()
}

func fail(_ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(1)
}

// MARK: - Cleanup (same rules as Alora's TextProcessor; the fillers are Japanese)

struct TextProcessor {
  var replacements: [String: String]

  private static let fillerRegex = try! NSRegularExpression(
    pattern:
      "(?:(?:えーっと|えーと|えっと|ええと|あーと|うーと|あのー+|そのー+|うーん|え[ー〜]+|あ[ー〜]+|う[ー〜]+|ん[ー〜]+)[、,\\s]*)+"
  )
  private static let katakanaFillerRegex = try! NSRegularExpression(
    pattern: "(?:(?:エーット|エート|エット|アノー+|ウーン|エ[ー〜]+|ア[ー〜]+|ウ[ー〜]+|ン[ー〜]+)(?![ァ-ヺー])[、,\\s]*)+"
  )
  private static let repeatedUnRegex = try! NSRegularExpression(pattern: "(?:うん[、,\\s]*){3,}")

  func process(_ text: String) -> String {
    var result = text
    result = Self.replace(Self.fillerRegex, in: result)
    result = Self.replace(Self.katakanaFillerRegex, in: result)
    result = Self.replace(Self.repeatedUnRegex, in: result)
    result = Self.tidy(result)
    for key in replacements.keys.sorted(by: { $0.count > $1.count }) {
      result = result.replacingOccurrences(of: key, with: replacements[key]!)
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func tidy(_ text: String) -> String {
    var r = text
    r = r.replacingOccurrences(of: "、。", with: "。")
    r = r.replacingOccurrences(of: "。、", with: "。")
    r = r.replacingOccurrences(of: "、+", with: "、", options: .regularExpression)
    r = r.replacingOccurrences(of: "。+", with: "。", options: .regularExpression)
    r = r.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    r = r.replacingOccurrences(of: "^[、。,\\s]+", with: "", options: .regularExpression)
    if r.allSatisfy({ "、。,.！？!? ".contains($0) }) { return "" }
    return r
  }

  private static func replace(_ regex: NSRegularExpression, in text: String) -> String {
    regex.stringByReplacingMatches(
      in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
  }
}

let defaultsDomain = ProcessInfo.processInfo.environment["PI_VOICE_DEFAULTS_DOMAIN"] ?? "com.ktorishima.alora"
let aloraDefaults = UserDefaults(suiteName: defaultsDomain)
let replacements = aloraDefaults?.dictionary(forKey: "replacements") as? [String: String] ?? [:]
let processor = TextProcessor(replacements: replacements)

// MARK: - Audio format conversion (same as Alora's BufferConverter)

final class BufferConverter {
  private var converter: AVAudioConverter?

  func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let inputFormat = buffer.format
    if inputFormat == format { return buffer }
    if converter?.inputFormat != inputFormat || converter?.outputFormat != format {
      converter = AVAudioConverter(from: inputFormat, to: format)
      converter?.primeMethod = .none
    }
    guard let converter else { return nil }
    let ratio = format.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if consumed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      inputStatus.pointee = .haveData
      return buffer
    }
    return status == .error ? nil : output
  }
}

// MARK: - Recognition

let locale = Locale(identifier: "ja-JP")

final class Transcript: @unchecked Sendable {
  private let lock = NSLock()
  private var finalized = ""
  private var volatile = ""

  func setVolatile(_ text: String) {
    lock.lock()
    volatile = text
    lock.unlock()
  }

  func addFinal(_ text: String) {
    lock.lock()
    finalized += text
    volatile = ""
    lock.unlock()
  }

  func current() -> String {
    lock.lock()
    defer { lock.unlock() }
    return finalized + volatile
  }

  func finalText() -> String {
    lock.lock()
    defer { lock.unlock() }
    return finalized
  }
}

func ensureAssets(for transcriber: DictationTranscriber) async throws {
  let id = locale.identifier(.bcp47)
  guard
    await DictationTranscriber.supportedLocales.contains(where: { $0.identifier(.bcp47) == id })
  else {
    fail("This Mac does not support Japanese speech recognition")
  }
  if await DictationTranscriber.installedLocales.contains(where: { $0.identifier(.bcp47) == id }) {
    return
  }
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
}

/// Take a stream of audio buffers, recognize them, and collect the final text
func transcribe(audio: AsyncStream<AVAudioPCMBuffer>, transcript: Transcript) async throws {
  let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
  try await ensureAssets(for: transcriber)
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
  else {
    fail("No audio format is available for speech recognition")
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  if !replacements.isEmpty {
    // Like Alora, pass the dictionary readings (katakana) as recognition hints
    let context = AnalysisContext()
    context.contextualStrings[.general] = Array(replacements.keys)
    try? await analyzer.setContext(context)
  }
  let (inputStream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)

  let results = Task {
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      if result.isFinal {
        transcript.addFinal(text)
      } else {
        transcript.setVolatile(text)
      }
      emit(["type": "partial", "text": processor.process(transcript.current())])
    }
  }

  try await analyzer.start(inputSequence: inputStream)

  let converter = BufferConverter()
  var frames: AVAudioFrameCount = 0
  for await buffer in audio {
    if let converted = converter.convert(buffer, to: format) {
      frames += converted.frameLength
      input.yield(AnalyzerInput(buffer: converted))
    }
  }
  input.finish()

  // Finalizing can hang if no audio ever arrived
  guard frames > 0 else {
    await analyzer.cancelAndFinishNow()
    results.cancel()
    return
  }
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  try await results.value
}

// MARK: - Sources

/// Read an audio file and stream it as buffers
func fileStream(_ path: String) -> AsyncStream<AVAudioPCMBuffer> {
  AsyncStream { continuation in
    do {
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      while file.framePosition < file.length {
        guard
          let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096)
        else { break }
        try file.read(into: buffer)
        if buffer.frameLength == 0 { break }
        continuation.yield(buffer)
      }
    } catch {
      fail("Could not read the audio file: \(error.localizedDescription)")
    }
    continuation.finish()
  }
}

/// Record from the microphone until "stop" / "cancel" arrives on stdin
final class Microphone: @unchecked Sendable {
  let engine = AVAudioEngine()

  func start(into continuation: AsyncStream<AVAudioPCMBuffer>.Continuation) {
    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      fail("No usable microphone found")
    }
    inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, _ in
      continuation.yield(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      fail("Could not open the microphone: \(error.localizedDescription)")
    }
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }
}

// MARK: - Main

let args = CommandLine.arguments
let transcript = Transcript()

Task {
  do {
    if let i = args.firstIndex(of: "--file"), i + 1 < args.count {
      try await transcribe(audio: fileStream(args[i + 1]), transcript: transcript)
    } else {
      let (stream, continuation) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
      let mic = Microphone()
      mic.start(into: continuation)
      emit(["type": "ready"])

      // Wait on stdin in another thread. If pi dies and stdin closes, discard and exit
      Thread.detachNewThread {
        while let line = readLine() {
          let command = line.trimmingCharacters(in: .whitespaces)
          if command == "stop" {
            mic.stop()
            continuation.finish()
            // If finalizing takes over 5 seconds, finish with what we have (same limit as Alora)
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
              emit(["type": "final", "text": processor.process(transcript.current())])
              exit(0)
            }
            return
          }
          if command == "cancel" { exit(0) }
        }
        exit(0)
      }

      try await transcribe(audio: stream, transcript: transcript)
    }
    emit(["type": "final", "text": processor.process(transcript.finalText())])
    exit(0)
  } catch {
    fail("Speech recognition failed: \(error.localizedDescription)")
  }
}

dispatchMain()
