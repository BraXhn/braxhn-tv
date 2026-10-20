// Spelar HLS-strömmar från servern med AVFoundation – samma avkodare och HLS-spelare som iPhone, iPad och
// Apple TV (och Safari). Används av macOS-jobbet i .github/workflows/conformance.yml via test/media/apple-check.mjs.
//
//   swiftc -O test/media/AVPlayerCheck.swift -o avcheck && ./avcheck fall.json resultat.json
//
// fall.json: [{ "name": "...", "url": "http://127.0.0.1:…/master.m3u8?…&t=…", "required": true }]
// För varje ström: vänta på readyToPlay, spela minst 4 s och hämta avkodade bilder (AVPlayerItemVideoOutput),
// spola till mitten och spela vidare. Fel från AVPlayerItem (error och errorLog) räknas som misslyckande.
import AVFoundation
import Foundation

struct Case: Decodable {
    let name: String
    let url: String
    let required: Bool?
}

struct Outcome: Encodable {
    var name: String
    var required: Bool
    var ok = false
    var status = "unknown"
    var error: String?
    var errorLog: [String] = []
    var frames = 0
    var played = 0.0
    var seekPlayed = 0.0
    var duration = 0.0
    var size = ""
    var codecs: [String] = []
}

/// Kör huvudtrådens körslinga tills villkoret är uppfyllt eller tiden gått ut
func spin(_ seconds: Double, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if cond() { return true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
    return cond()
}

func fourcc(_ v: FourCharCode) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((v >> UInt32($0)) & 0xff) }
    return String(bytes: bytes, encoding: .ascii) ?? "?"
}

func run(_ c: Case) -> Outcome {
    var r = Outcome(name: c.name, required: c.required ?? true)
    guard let url = URL(string: c.url) else { r.error = "ogiltig URL"; return r }
    let item = AVPlayerItem(url: url)
    let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    item.add(output)
    let player = AVPlayer(playerItem: item)
    player.isMuted = true
    player.automaticallyWaitsToMinimizeStalling = false

    func collect() {
        if let e = item.error as NSError? {
            let under = (e.userInfo[NSUnderlyingErrorKey] as? NSError).map { " (\($0.domain) \($0.code))" } ?? ""
            r.error = "\(e.domain) \(e.code): \(e.localizedDescription)\(under)"
        }
        r.errorLog = (item.errorLog()?.events ?? []).map { "\($0.errorDomain) \($0.errorStatusCode): \($0.errorComment ?? "")" }
        r.size = "\(Int(item.presentationSize.width))x\(Int(item.presentationSize.height))"
        var codecs: [String] = []
        for t in item.tracks {
            guard let a = t.assetTrack else { continue }
            for f in a.formatDescriptions {
                let desc = f as! CMFormatDescription
                codecs.append("\(a.mediaType.rawValue):\(fourcc(CMFormatDescriptionGetMediaSubType(desc)))")
            }
        }
        r.codecs = codecs
    }
    func pull() {
        let t = item.currentTime()
        if output.hasNewPixelBuffer(forItemTime: t), output.copyPixelBuffer(forItemTime: t, itemTimeForDisplay: nil) != nil { r.frames += 1 }
    }

    _ = spin(90) { item.status != .unknown }
    r.status = item.status == .readyToPlay ? "readyToPlay" : item.status == .failed ? "failed" : "unknown"
    guard item.status == .readyToPlay else { collect(); return r }
    r.duration = item.duration.seconds.isFinite ? item.duration.seconds : 0
    player.play()
    _ = spin(90) { pull(); return player.currentTime().seconds >= 4 || item.status == .failed }
    r.played = player.currentTime().seconds

    if r.duration > 10 && item.status == .readyToPlay {
        // Utan completion handler (den är @Sendable i nyare SDK:er) – vänta tills tiden hamnat vid målet
        let target = r.duration / 2
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        _ = spin(60) { abs(player.currentTime().seconds - target) < 1 || item.status == .failed }
        let from = player.currentTime().seconds
        player.play()
        _ = spin(90) { pull(); return player.currentTime().seconds >= from + 2 || item.status == .failed }
        r.seekPlayed = player.currentTime().seconds - from
    }
    player.pause()
    collect()
    r.status = item.status == .readyToPlay ? "readyToPlay" : item.status == .failed ? "failed" : "unknown"
    r.ok = item.status == .readyToPlay && r.error == nil && r.played >= 3 && r.frames >= 5 && (r.duration <= 10 || r.seekPlayed >= 1.5)
    return r
}

let args = CommandLine.arguments
guard args.count >= 3, let data = FileManager.default.contents(atPath: args[1]) else {
    FileHandle.standardError.write("användning: avcheck fall.json resultat.json\n".data(using: .utf8)!)
    exit(2)
}
let cases = try JSONDecoder().decode([Case].self, from: data)
var results: [Outcome] = []
for c in cases {
    let r = run(c)
    results.append(r)
    let mark = r.ok ? "ok " : (r.required ? "FEL" : "obs")
    print("[\(mark)] \(r.name): \(r.status), spelat \(String(format: "%.1f", r.played)) s, efter spolning \(String(format: "%.1f", r.seekPlayed)) s, \(r.frames) bilder, \(r.size) \(r.codecs.joined(separator: ","))\(r.error.map { " – " + $0 } ?? "")")
    for e in r.errorLog { print("      errorLog: \(e)") }
}
let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
try enc.encode(results).write(to: URL(fileURLWithPath: args[2]))
exit(results.contains { !$0.ok && $0.required } ? 1 : 0)
