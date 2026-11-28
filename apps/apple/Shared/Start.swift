import SwiftUI

// Snabbare start: frågan till /playback, förvärmningen och stopp av en ström som aldrig användes. Reglerna står i
// StartCore.swift (bara Foundation); här är anropen. Samma som Android-appens Start.kt.

/// Svaret på /playback?warm=1 ({ warm, mode }) – läses inte, men get vill ha en typ
private struct WarmReply: Decodable {
    let warm: Bool?
    let mode: String?
}

@MainActor
enum Start {
    private static var log = StartCore.WarmLog()

    /// Hela frågan till /playback för en uppspelning från början eller en position. Samma för förvärmningen och
    /// uppspelningen (Player.swift), så att servern kan ta över den förvärmda strömmen. subtitle: bara en bildundertext
    /// skickas (AppModel.capabilities), textundertexter väljer spelaren själv. cinema: false vid en omstart mitt i.
    /// bw: uppkopplingen utanför hemmet (Bandwidth.forPlay) – samma värde i förvärmningen och uppspelningen.
    static func query(_ model: AppModel, audio: Int?, subtitle: SubtitleTrack?, start: Double, cinema: Bool, bw: Int?) -> [URLQueryItem] {
        model.capabilities(audio: audio, subtitle: subtitle) + model.comfortQuery() + StartCore.playExtras(start: start, cinema: cinema) + BwCore.query(bw)
    }

    /// /playback?warm=1 – tyst; servern svarar { warm, mode } och räknar inget som uppspelning
    static func warm(_ model: AppModel, id: Int, start: Double, audio: Int?, subtitle: SubtitleTrack?) {
        guard id > 0 else { return }
        #if os(iOS)
        if Downloads.shared.localURL(for: id) != nil { return } // en nedladdad titel spelas från enheten
        #endif
        // bw: samma som uppspelningen sedan skickar (BwCore.playBw); utan mätning inget, och då gäller serverns gissning
        let bw = Bandwidth.forPlay(model, id: id)
        let q = StartCore.warmQuery(query(model, audio: audio, subtitle: subtitle, start: start, cinema: true, bw: bw))
        guard log.take(StartCore.key(id: id, q), now: Date().timeIntervalSince1970) else { return }
        Bandwidth.didWarm(id: id, bw: bw)
        Task { let _: WarmReply? = try? await model.get("/api/items/\(id)/playback", q) }
    }

    /// Strömmen som servern startade för p behövs inte (spelaren stängdes eller titeln gick inte att hämta)
    static func drop(_ model: AppModel, id: Int, _ p: Playback) async {
        guard let pid = SeekCore.pidOf(p.url) else { return }
        _ = try? await model.post("/api/stream/\(id)/stop?pid=\(pid)")
    }
}

/// Förvärmning när fokus står kvar på knappen (Apple TV, tangentbord på iPad) i StartCore.dwell sekunder – inte för
/// varje knapp eller avsnitt man rör sig förbi. Samma titel, position, ljudspår och undertext som knappen sedan spelar.
struct WarmOnFocus: ViewModifier {
    @EnvironmentObject var model: AppModel
    let id: Int
    let start: Double
    let audio: Int?
    let subtitle: SubtitleTrack?
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focused($focused)
            // Ny fokus (eller fokus bort) avbryter väntan: task(id:) startar om
            .task(id: focused) { await dwell() }
    }

    @MainActor private func dwell() async {
        guard focused else { return }
        try? await Task.sleep(nanoseconds: UInt64(StartCore.dwell * 1_000_000_000))
        guard focused, !Task.isCancelled else { return }
        Start.warm(model, id: id, start: start, audio: audio, subtitle: subtitle)
    }
}

extension View {
    func warmOnFocus(_ id: Int, start: Double, audio: Int? = nil, subtitle: SubtitleTrack? = nil) -> some View {
        modifier(WarmOnFocus(id: id, start: start, audio: audio, subtitle: subtitle))
    }
}
