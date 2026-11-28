import Foundation

// Uppkopplingen utanför hemmet: mätningen i bakgrunden, den sparade takten och vad som skickas som bw. Reglerna står
// i BwCore.swift (bara Foundation); här är anropen. Samma regler som webben (web/js/player/caps.js) och Android-appen.

@MainActor
enum Bandwidth {
    private static var book = BwCore.Book()
    /// Servern som mätningen gäller (en annan server är en annan uppkoppling)
    private static var bookServer = ""
    private static var running: Task<Void, Never>?
    /// Förvärmningen som senast skickade bw (uppspelningen av samma titel skickar samma, BwCore.playBw)
    private(set) static var warmed: BwCore.Warmed?

    private static var now: Double { Date().timeIntervalSince1970 }

    /// Utanför hemmet: servern säger remote och appen går inte via hemadressen
    static func outside(_ model: AppModel) -> Bool {
        BwCore.outside(remote: model.remote, viaHome: model.home.via != nil)
    }

    /// Den färska takten (kbit/s) utanför hemmet, annars nil
    static func fresh(_ model: AppModel) -> Int? {
        guard outside(model), bookServer == model.server else { return nil }
        return book.fresh(now: now, net: model.home.net.generation)
    }

    /// En ny takt – från provet eller från AVPlayer under uppspelningen. Hemma sparas inget.
    static func note(_ model: AppModel, kbps: Int) {
        guard outside(model), kbps > 0 else { return }
        bookServer = model.server
        book.note(kbps, now: now, net: model.home.net.generation)
    }

    /// AVPlayers uppmätta takt (accessLog().events.last?.observedBitrate, bit/s)
    static func note(_ model: AppModel, observedBitrate b: Double?) {
        if let b, let k = BwCore.kbps(observedBitrate: b) { note(model, kbps: k) }
    }

    /// bw för förvärmningen och uppspelningen av id (samma värde för båda, BwCore.playBw). Utanför hemmet utan färsk
    /// mätning: nil (serverns gissning gäller) och en mätning startar i bakgrunden till nästa gång – starten väntar inte.
    static func forPlay(_ model: AppModel, id: Int) -> Int? {
        guard outside(model) else { return nil }
        let f = fresh(model)
        if f == nil { kick(model) }
        return BwCore.playBw(fresh: f, warmed: warmed, id: id, now: now)
    }

    /// Förvärmningen av id skickade bw (nil = inget bw)
    static func didWarm(id: Int, bw: Int?) {
        warmed = BwCore.Warmed(id: id, bw: bw, at: now)
    }

    /// Mät i bakgrunden om appen är utanför hemmet och saknar en färsk mätning. Inte medan provet av hemadressen pågår
    /// (det kan visa att appen är hemma); det anropar kick igen när det är klart.
    static func kick(_ model: AppModel) {
        guard model.isLoggedIn, running == nil, model.home.checking == 0, outside(model), fresh(model) == nil,
              let tok = model.token,
              let u = model.url("/api/speedtest", [URLQueryItem(name: "kb", value: String(BwCore.sampleKB)),
                                                   URLQueryItem(name: "n", value: String(Int(now * 1000)))]) else { return }
        let net = model.home.net.generation, server = model.server
        var r = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
        running = Task { @MainActor in
            let k = await SpeedProbe.measure(r)
            Bandwidth.running = nil
            // Nätet eller servern byttes medan provet pågick, eller appen är hemma nu: takten gäller inte
            guard net == model.home.net.generation, server == model.server else { return }
            Bandwidth.note(model, kbps: k)
        }
    }
}

/// Provet: läser /api/speedtest och noterar när varje bit kommer, högst BwCore.sampleSeconds från första byte.
/// Tiden tas med systemUptime (påverkas inte om klockan ställs). Svaret blir 0 vid fel.
final class SpeedProbe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var marks: [(t: Double, bytes: Int)] = []
    private var got = 0
    private var cont: CheckedContinuation<Int, Never>?
    private var task: URLSessionDataTask?

    static func measure(_ request: URLRequest) async -> Int {
        let probe = SpeedProbe()
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: c, delegate: probe, delegateQueue: nil)
        let kbps = await withCheckedContinuation { (k: CheckedContinuation<Int, Never>) in
            probe.start(session.dataTask(with: request), k)
        }
        session.invalidateAndCancel()
        return kbps
    }

    private func start(_ t: URLSessionDataTask, _ k: CheckedContinuation<Int, Never>) {
        lock.lock(); task = t; cont = k; lock.unlock()
        t.resume()
    }

    /// Klart: svara en gång och avbryt resten av hämtningen
    private func finish(_ kbps: Int) {
        lock.lock()
        let k = cont; cont = nil
        let t = task; task = nil
        lock.unlock()
        t?.cancel()
        k?.resume(returning: kbps)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { completionHandler(.cancel); finish(0); return }
        lock.lock(); marks = [(ProcessInfo.processInfo.systemUptime, 0)]; lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        got += data.count
        marks.append((now, got))
        let m = now - (marks.first?.t ?? now) > BwCore.sampleSeconds ? marks : nil
        lock.unlock()
        if let m { finish(BwCore.rate(m)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let m = marks; lock.unlock()
        // Hela provet kom inom tiden (snabb uppkoppling): takten på det som kom; fel eller avbrutet utan data: 0
        finish(error == nil ? BwCore.rate(m) : 0)
    }
}
