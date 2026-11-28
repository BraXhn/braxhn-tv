import Foundation

// Uppkopplingen utanför hemmet (bw), utan SwiftUI och AVFoundation (bara Foundation – ren logik). Samma regler som
// webben (sample, lastBandwidth och noteBandwidth i web/js/player/caps.js) och Android-appen:
// - Utanför hemmet = servern räknar anslutningen som utanför (remote i /api/status, samma som webbens status.remote)
//   och appen går inte via serverns hemadress (Hemma.swift). Hemma skickas aldrig bw och ingenting mäts.
// - Mätningen: 4 MB från /api/speedtest, högst 1 s, takten räknas på det som kommer efter första tredjedelen (rate).
//   Görs i bakgrunden när appen öppnas eller kommer tillbaka, och när nätet byts – aldrig medan starten väntar.
// - AVPlayer mäter själv under uppspelningen (accessLog().events.last?.observedBitrate): den takten ersätter provet.
// - En mätning gäller i 10 minuter (maxAge, som webben) och bara på samma nät: byts nätet räknas den inte längre.
// - Utan färsk mätning skickas inget bw: då gäller serverns gissning (startsteget i server/stream.js abrOrder).
// - Förvärmningen och uppspelningen måste skicka samma bw, annars tar servern inte över den förvärmda strömmen
//   (warmSig i server/routes/playback.js). Uppspelningen av en titel som nyss förvärmts skickar därför förvärmningens
//   bw – också inget bw, om förvärmningen skickades innan någon mätning fanns (playBw). Webben förvärmer inte alls
//   utanför hemmet utan mätning; appen gör det, så att starten aldrig blir långsammare än utan mätning.
// Anropen: Bandwidth.swift, Start.swift och Player.swift. Testas statiskt i test/apple-bw.test.js.

enum BwCore {
    /// Så länge en mätning gäller (s) – samma som webben (lastBandwidth: 10 minuter)
    static let maxAge: Double = 600
    /// Provets storlek (kB) och längsta tid (s) – samma som webbens SAMPLE_KB och SAMPLE_MS
    static let sampleKB = 4096
    static let sampleSeconds: Double = 1
    /// Så länge servern håller en förvärmd ström (s, warmed i server/routes/playback.js): så länge använder
    /// uppspelningen förvärmningens bw
    static let warmHold: Double = 20

    /// Ska appen mäta och skicka bw? remote: servern säger utanför hemmet; viaHome: appen går via hemadressen.
    static func outside(remote: Bool, viaHome: Bool) -> Bool { remote && !viaHome }

    /// Takten (kbit/s) ur provets märken [(sekunder, mottagna byte hittills)], första märket när svaret började komma.
    /// Räknas från första märket där en tredjedel kommit (TCP:s långsamma början och svarstiden hör inte till
    /// uppkopplingens takt); kom nästan allt i en bit räknas hela provet. Samma som rateOf i web/js/player/hlsconfig.js.
    static func rate(_ marks: [(t: Double, bytes: Int)]) -> Int {
        guard marks.count >= 2, let last = marks.last else { return 0 }
        let total = last.bytes
        let from = marks.first(where: { Double($0.bytes) >= Double(total) / 3 }) ?? marks[0]
        let a = last.t - from.t >= 0.02 && last.bytes > from.bytes ? from : marks[0]
        let secs = max(0.001, last.t - a.t), bytes = max(0, last.bytes - a.bytes)
        return bytes > 0 ? Int((Double(bytes) * 8 / (secs * 1000)).rounded()) : 0
    }

    /// AVPlayers uppmätta takt (observedBitrate, bit/s) i kbit/s – nil när den saknas (0, negativ eller NaN)
    static func kbps(observedBitrate b: Double) -> Int? {
        guard b.isFinite, b > 0 else { return nil }
        let k = Int((b / 1000).rounded())
        return k > 0 ? min(k, 1_000_000) : nil
    }

    /// bw i frågan till /playback (kbit/s), eller ingenting
    static func query(_ kbps: Int?) -> [URLQueryItem] {
        guard let k = kbps, k > 0 else { return [] }
        return [URLQueryItem(name: "bw", value: String(k))]
    }

    /// Senaste mätningen: takten, när den gjordes och på vilket nät (HomeNet.generation)
    struct Book {
        private(set) var kbps = 0
        private(set) var at = -Double.infinity
        private(set) var net = -1
        private let maxAge: Double

        init(maxAge: Double = BwCore.maxAge) { self.maxAge = maxAge }

        /// Takten om mätningen är färsk och gjord på samma nät, annars nil
        func fresh(now: Double, net: Int) -> Int? {
            guard kbps > 0, net == self.net, now - at < maxAge, now >= at else { return nil }
            return kbps
        }

        /// En ny mätning (provet eller AVPlayer). 0 eller mindre glöms bort.
        mutating func note(_ kbps: Int, now: Double, net: Int) {
            guard kbps > 0 else { return }
            self.kbps = kbps; self.at = now; self.net = net
        }
    }

    /// Förvärmningen som senast skickade bw: titeln, takten och när
    struct Warmed: Equatable {
        let id: Int
        let bw: Int?
        let at: Double
    }

    /// bw för förvärmningen och uppspelningen av id utanför hemmet: förvärmningens bw (även inget) när samma titel
    /// förvärmts nyss (servern håller strömmen i warmHold sekunder) – annars den färska mätningen. Så blir frågan
    /// densamma även om en mätning blev klar emellan.
    static func playBw(fresh: Int?, warmed: Warmed?, id: Int, now: Double) -> Int? {
        if let w = warmed, w.id == id, now >= w.at, now - w.at < warmHold { return w.bw }
        return fresh
    }
}
