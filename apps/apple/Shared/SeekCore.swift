import Foundation

// Spolning i en omkodad ström, utan AVFoundation (bara Foundation – ren logik). Spellistan har 6 s-segment, och servern
// måste koda hela segmentet med målet innan något kan visas (3–4,5 s för en 1080p-film). Spolar man utanför det som är
// buffrat startar spelaren i stället om strömmen vid målet (/playback med start= och prev=<förra strömmens pid>):
// servern ger korta segment där (1 s med processorn, 2 s med grafikkortet, som vid Fortsätt titta) och stoppar den
// gamla strömmen direkt. Samma regler som webbspelaren (seekRestart i web/js/player/hlsconfig.js), Expo-appen
// (apps/expo/src/seekcore.ts) och Android-appen (SeekCore.kt). Spelaren och anropen: Player.swift (seekRestart).
//
// Som i Expo-appen: AVPlayer visar inte serverns svarshuvuden (X-Seg-Ready) och har ingen händelse före en spolning.
// Spolningen märks som ett hopp i positionen (seekJump, mätningarna var 0,25 s och vid varje hopp) och vilka segment
// servern har klara gissas ur var körningen startade och spelarens buffert (readyGuess) – försiktigt, så hellre en
// omstart för mycket än en väntan på ett helt 6 s-segment.

enum SeekCore {
    /// Ett segment i spellistan: start och längd i sekunder
    struct Frag: Equatable {
        let start: Double
        let duration: Double
    }

    /// En mätning av spelaren: position och buffertens slut i sekunder, när (s), om den spelade och hastigheten
    struct Sample: Equatable {
        let pos: Double
        let buf: Double
        let at: Double
        let playing: Bool
        var rate: Double = 1
    }

    /// Fjärrkontrollens steg (Apple TV: klick åt höger/vänster = 10 s) och reglaget som drar spolar många gånger i rad:
    /// omstarten väntar så här länge på nästa hopp, så att fem steg blir en omstart vid det sista målet (som Android)
    static let stepSettle: Double = 0.6

    /// Servern tar bort segment som ligger mer än 30 segment bakom det spelaren senast bad om (BEHIND i server/stream.js)
    static let behind = 30

    /// Segmenten i en HLS-medialista (#EXTINF) med start och längd
    static func parseFrags(_ m3u8: String) -> [Frag] {
        var out: [Frag] = []
        var t = 0.0
        for raw in m3u8.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("#EXTINF:") else { continue }
            let num = line.dropFirst(8).prefix(while: { $0.isNumber || $0 == "." })
            guard let d = Double(num), d > 0 else { continue }
            out.append(Frag(start: t, duration: d))
            t += d
        }
        return out
    }

    /// Segmentet som innehåller t, eller -1
    static func fragAt(_ frags: [Frag], _ t: Double) -> Int {
        guard t.isFinite else { return -1 }
        return frags.firstIndex { t >= $0.start - 0.001 && t < $0.start + $0.duration } ?? -1
    }

    /// Medialistan bakom mastern (samma frågesträng, samma segmentgränser i alla kvalitetssteg)
    static func indexURL(_ master: String) -> String {
        master.replacingOccurrences(of: "/hls/master.m3u8", with: "/hls/index.m3u8")
    }

    /// pid i strömmens adress (just den här uppspelningen), eller nil
    static func pidOf(_ url: String?) -> String? {
        guard let u = url, let r = u.range(of: "[?&]pid=[0-9a-f]{8}(&|$)", options: .regularExpression) else { return nil }
        let m = u[r].drop(while: { $0 != "=" }).dropFirst().prefix(8)
        return String(m)
    }

    /// Strömadressen med startpositionen för spellistan (xs → EXT-X-START, så att AVPlayer börjar där och inte på
    /// segment 0). Servern lägger själv till xs när appen skickar nhls=1 (iPhone/iPad); Apple TV skickar inte nhls –
    /// då skulle Dolby Digital i TS bli AAC – så appen lägger till det. xs ingår inte i sessionen på servern. Ett
    /// befintligt xs byts (samma ström, ny position). Under 1 s: ingen startposition.
    static func withStart(_ url: String, at start: Double) -> String {
        guard url.contains("/hls/master.m3u8") else { return url }
        var parts = url.components(separatedBy: "?")
        let path = parts.removeFirst()
        var items = parts.joined(separator: "?").split(separator: "&").map(String.init).filter { !$0.hasPrefix("xs=") }
        if start.isFinite, start >= 1 { items.append("xs=\(Int(start))") }
        return items.isEmpty ? path : path + "?" + items.joined(separator: "&")
    }

    /**
     * Segmenten [från, till] som servern troligen har klara i den pågående omkodningen: från segmentet där körningen
     * startade (runSeg) till segmentet där spelarens buffert slutar – spelaren har hämtat dem, så servern har kodat dem.
     */
    static func readyGuess(_ frags: [Frag], runSeg: Int, bufferedEnd: Double) -> ClosedRange<Int>? {
        guard !frags.isEmpty, runSeg >= 0 else { return nil }
        let last = frags.count - 1
        var hi = fragAt(frags, max(0, bufferedEnd - 0.05))
        if hi < 0 { hi = bufferedEnd >= frags[last].start ? last : runSeg }
        hi = max(hi, runSeg)
        return max(runSeg, hi - behind + 1)...hi
    }

    /**
     * Ska spelaren starta om strömmen vid t i stället för att hämta segmentet? Nej när
     * - ingen bild har visats än i strömmen (spelarens egna hopp vid starten),
     * - t redan är buffrat (buffered = [start, slut] i sekunder),
     * - segmentet redan är kort (början av filen, efter en omstart eller Fortsätt titta),
     * - t är nära slutet (där ger servern inga korta segment),
     * - servern har segmentet klart eller kodar det just nu (ready, segmentet efter "till" kodas).
     */
    static func shouldRestart(buffered: [(Double, Double)], t: Double, frags: [Frag], ready: ClosedRange<Int>?, started: Bool) -> Bool {
        guard started, t.isFinite, let last = frags.last else { return false }
        if buffered.contains(where: { t >= $0.0 - 0.1 && t < $0.1 }) { return false }
        let n = fragAt(frags, t)
        guard n >= 0 else { return false }
        if t > last.start + last.duration - 4 { return false }
        if frags[n].duration <= 2.01 { return false }
        if let r = ready, n >= r.lowerBound, n <= r.upperBound + 1 { return false }
        return true
    }

    /// Har användaren spolat mellan två mätningar? Mer än 2,5 s framåt jämfört med hur långt den hinner spela, eller
    /// mer än 1,5 s bakåt. Ett stopp för buffring flyttar inte positionen, så det räknas inte.
    static func seekJump(_ prev: Sample, _ now: Sample) -> Bool {
        guard prev.pos.isFinite, now.pos.isFinite else { return false }
        let secs = max(0, now.at - prev.at)
        let ran = prev.playing ? secs * (prev.rate > 0 ? prev.rate : 1) : 0
        return now.pos > prev.pos + ran + 2.5 || now.pos < prev.pos - 1.5
    }

    /// Beslutet efter ett hopp från prev (före spolningen) till t. Bufferten före spolningen är prev.pos–prev.buf.
    static func decide(_ prev: Sample, t: Double, frags: [Frag], runSeg: Int, started: Bool) -> Bool {
        let ready = readyGuess(frags, runSeg: runSeg, bufferedEnd: prev.buf)
        return shouldRestart(buffered: prev.buf > prev.pos ? [(prev.pos, prev.buf)] : [], t: t, frags: frags, ready: ready, started: started)
    }

    /// Spolningen gav ingen omstart: var körningen på servern börjar nu (låg målet utanför det servern hade startar
    /// den om omkodningen vid målet)
    static func runAfterSeek(_ prev: Sample, t: Double, frags: [Frag], runSeg: Int) -> Int {
        let n = fragAt(frags, t)
        guard n >= 0 else { return runSeg }
        if let r = readyGuess(frags, runSeg: runSeg, bufferedEnd: prev.buf), n >= r.lowerBound, n <= r.upperBound + 1 { return runSeg }
        return n
    }

    /// Vad spelaren ska göra efter en mätning
    enum Action: Equatable {
        /// Inget att göra
        case keep
        /// Starta om vid målet när inget nytt hopp kommit på stepSettle sekunder (ett nytt hopp flyttar målet)
        case restart(Double)
        /// Ett nytt hopp hamnade där spelaren klarar sig själv: den väntande omstarten behövs inte
        case cancel
    }

    /// En omkodad ström som spelas: segmenten, var körningen på servern startade och mätningarna
    struct Watch {
        var frags: [Frag] = []
        var runSeg = -1
        /// Bilden har visats i strömmen (hopp före det är spelarens egna, till startpositionen)
        var started = false
        private(set) var last: Sample?
        /// Mätningen före första hoppet i en serie (fjärrkontrollens steg) – bufferten som gällde före spolningen
        private(set) var before: Sample?
        /// Målet för en omstart som väntar på fler steg
        private(set) var pending: Double?

        init() {}

        /// Spellistan har hämtats: körningen på servern startade vid segmentet med from
        mutating func setFrags(_ f: [Frag], from: Double) {
            frags = f
            runSeg = max(0, SeekCore.fragAt(f, from))
        }

        /// Bilden visas: hopp räknas från nu
        mutating func markStarted() {
            guard !started else { return }
            started = true
            last = nil
        }

        /// En ny mätning: har användaren spolat, och ska strömmen startas om vid målet?
        mutating func observe(_ now: Sample) -> Action {
            guard let prev = last else { last = now; return .keep }
            last = now
            guard started, !frags.isEmpty, SeekCore.seekJump(prev, now) else { return .keep }
            let base = before ?? prev
            if SeekCore.decide(base, t: now.pos, frags: frags, runSeg: runSeg, started: started) {
                if before == nil { before = prev }
                pending = now.pos
                return .restart(now.pos)
            }
            let wasPending = pending != nil
            runSeg = SeekCore.runAfterSeek(base, t: now.pos, frags: frags, runSeg: runSeg)
            pending = nil
            before = nil
            return wasPending ? .cancel : .keep
        }
    }
}
