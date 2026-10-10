import SwiftUI
import AVKit
import AVFoundation

struct SubtitleCue {
    let start: Double
    let end: Double
    let text: String
}

/// Minimal WebVTT-tolkare (servern levererar alltid WebVTT).
enum VTT {
    static func parse(_ s: String) -> [SubtitleCue] {
        var cues: [SubtitleCue] = []
        let blocks = s.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n")
        for b in blocks {
            let lines = b.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let i = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[i].components(separatedBy: "-->")
            guard parts.count == 2, let a = time(parts[0]), let e = time(parts[1].trimmingCharacters(in: .whitespaces).components(separatedBy: " ").first ?? "") else { continue }
            let text = lines[(i + 1)...].joined(separator: "\n")
                .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { cues.append(SubtitleCue(start: a, end: e, text: text)) }
        }
        return cues.sorted { $0.start < $1.start }
    }
    static func time(_ raw: String) -> Double? {
        let p = raw.trimmingCharacters(in: .whitespaces).split(separator: ":").map { Double($0.replacingOccurrences(of: ",", with: ".")) }
        if p.contains(where: { $0 == nil }) { return nil }
        let v = p.compactMap { $0 }
        switch v.count {
        case 3: return v[0] * 3600 + v[1] * 60 + v[2]
        case 2: return v[0] * 60 + v[1]
        default: return nil
        }
    }
}

@MainActor
final class PlayerController: ObservableObject {
    let player = AVPlayer()
    @Published var subtitleText = ""
    @Published var skipTitle: String?
    @Published var status = ""
    @Published var error: String?
    @Published var title = ""

    private let model: AppModel
    private var item: MediaItem?
    private var pb: Playback?
    private var cues: [SubtitleCue] = []
    var subtitleOffset: Double = 0
    private var observer: Any?
    private var endObserver: NSObjectProtocol?
    private var lastReport = Date.distantPast
    private var audio: Int?
    private var subtitle: SubtitleTrack?
    var onFinished: (() -> Void)?

    init(model: AppModel) {
        self.model = model
        player.allowsExternalPlayback = true // AirPlay till Apple TV
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
    }

    func start(itemId: Int, at start: Double, audio: Int?, subtitle: SubtitleTrack?) async {
        stopReporting(final: true)
        self.audio = audio
        do {
            let it: MediaItem = try await model.get("/api/items/\(itemId)")
            item = it
            title = it.isEpisode ? "\(it.showTitle ?? "") · \(it.sxe) · \(it.title)" : it.title
            // Standardundertext om ingen valts
            var sub = subtitle
            if sub == nil, let subs = it.subtitles {
                sub = subs.first { $0.forced == true && $0.bitmap != true }
                    ?? subs.first { !model.subtitleLang.isEmpty && $0.lang == model.subtitleLang && $0.bitmap != true }
            }
            self.subtitle = sub
            let p: Playback = try await model.get("/api/items/\(itemId)/playback", model.capabilities(audio: audio, subtitle: sub))
            pb = p
            status = [p.mode == "direct" ? "Direkt" : p.mode == "remux" ? "Remux" : "Omkodning",
                      p.tonemap == true ? "HDR→SDR" : nil, p.remote == true ? "utanför hemmet" : nil].compactMap { $0 }.joined(separator: " · ")
            guard let url = model.absolute(p.url) else { throw APIError(message: "Ogiltig ström-URL") }
            let asset = AVURLAsset(url: url)
            let playerItem = AVPlayerItem(asset: asset)
            playerItem.externalMetadata = metadata(it)
            player.replaceCurrentItem(with: playerItem)
            if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
            player.play()
            cues = []
            subtitleText = ""
            if let s = sub, s.bitmap != true, let ps = p.subtitles.first(where: { $0.id == s.id }) { await loadCues(ps) }
            installObservers()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func metadata(_ it: MediaItem) -> [AVMetadataItem] {
        let t = AVMutableMetadataItem()
        t.identifier = .commonIdentifierTitle
        t.value = (it.isEpisode ? "\(it.showTitle ?? "") – \(it.title)" : it.title) as NSString
        t.extendedLanguageTag = "und"
        var out: [AVMetadataItem] = [t]
        if let o = it.overview {
            let d = AVMutableMetadataItem()
            d.identifier = .commonIdentifierDescription
            d.value = o as NSString
            d.extendedLanguageTag = "und"
            out.append(d)
        }
        return out
    }

    private func loadCues(_ s: PlaybackSubtitle) async {
        guard let url = model.absolute(s.url) else { return }
        if let res = try? await URLSession.shared.data(from: url), let txt = String(data: res.0, encoding: .utf8) {
            cues = VTT.parse(txt)
        }
    }

    private func installObservers() {
        if let o = observer { player.removeTimeObserver(o) }
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
            let secs = t.seconds
            Task { @MainActor [weak self] in self?.tick(secs) }
        }
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.ended() }
        }
    }

    private func tick(_ t: Double) {
        guard t.isFinite else { return }
        // Undertexter
        let st = t - subtitleOffset
        if let c = cues.last(where: { $0.start <= st }), st <= c.end { if subtitleText != c.text { subtitleText = c.text } }
        else if !subtitleText.isEmpty { subtitleText = "" }
        // Hoppa över intro / nästa avsnitt
        var skip: String?
        if let r = pb?.recap, t >= r.start, t < r.end - 1 { skip = "Hoppa över sammanfattning" }
        else if let i = pb?.intro, t >= i.start, t < i.end - 1 { skip = "Hoppa över intro" }
        else if let c = pb?.credits, item?.nextId != nil, t >= c, t < c + 60 { skip = "Nästa avsnitt" }
        if skip != skipTitle { skipTitle = skip }
        // Tittarstatus var 10:e sekund
        if Date().timeIntervalSince(lastReport) > 10, t > 1, let it = item {
            lastReport = Date()
            model.reportProgress(id: it.id, position: t, duration: pb?.duration ?? it.duration ?? 0)
        }
    }

    func skip() {
        guard let t = skipTitle else { return }
        if t == "Hoppa över sammanfattning", let r = pb?.recap {
            player.seek(to: CMTime(seconds: r.end, preferredTimescale: 600))
        } else if t == "Hoppa över intro", let i = pb?.intro {
            player.seek(to: CMTime(seconds: i.end, preferredTimescale: 600))
        } else if let next = item?.nextId {
            Task { await start(itemId: next, at: 0, audio: nil, subtitle: nil) }
        }
    }

    private func ended() {
        stopReporting(final: true)
        if let next = item?.nextId { Task { await start(itemId: next, at: 0, audio: nil, subtitle: nil) } }
        else { onFinished?() }
    }

    private func stopReporting(final: Bool) {
        guard let it = item else { return }
        let t = player.currentTime().seconds
        if final, t.isFinite, t > 1 { model.reportProgress(id: it.id, position: t, duration: pb?.duration ?? it.duration ?? 0) }
        Task { try? await model.post("/api/stream/\(it.id)/stop") }
    }

    func close() {
        stopReporting(final: true)
        player.pause()
        if let o = observer { player.removeTimeObserver(o); observer = nil }
        if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
        player.replaceCurrentItem(with: nil)
    }
}

struct PlayerVC: UIViewControllerRepresentable {
    let player: AVPlayer
    let skipTitle: String?
    let onSkip: () -> Void

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        #if os(iOS)
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        #endif
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {
        #if os(tvOS)
        // På Apple TV visas knappen i spelarens egna kontroller (fokuserbar med fjärrkontrollen)
        if let t = skipTitle {
            vc.contextualActions = [UIAction(title: t, image: UIImage(systemName: "forward.end.fill")) { _ in onSkip() }]
        } else {
            vc.contextualActions = []
        }
        #endif
    }
}

struct PlayerScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let request: PlayRequest
    @StateObject private var holder = Holder()

    final class Holder: ObservableObject { @Published var ctrl: PlayerController? }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let c = holder.ctrl { PlayerContent(ctrl: c, close: close) }
        }
        .task {
            if holder.ctrl == nil {
                let c = PlayerController(model: model)
                c.onFinished = { close() }
                holder.ctrl = c
                await c.start(itemId: request.itemId, at: request.start, audio: request.audio, subtitle: request.subtitle)
            }
        }
        .onDisappear { holder.ctrl?.close() }
        #if os(iOS)
        .statusBarHidden()
        #endif
    }

    func close() {
        holder.ctrl?.close()
        dismiss()
    }
}

struct PlayerContent: View {
    @ObservedObject var ctrl: PlayerController
    let close: () -> Void

    var body: some View {
        ZStack {
            PlayerVC(player: ctrl.player, skipTitle: ctrl.skipTitle, onSkip: { ctrl.skip() })
                .ignoresSafeArea()
            // Undertexter ritas av appen (fungerar för alla lägen, även direktuppspelning)
            VStack {
                Spacer()
                if !ctrl.subtitleText.isEmpty {
                    Text(ctrl.subtitleText)
                        .font(subtitleFont)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .shadow(color: .black, radius: 2)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 6))
                        .padding(.bottom, subtitleBottom)
                }
            }
            .allowsHitTesting(false)
            #if os(iOS)
            VStack {
                HStack {
                    Button { close() } label: { Image(systemName: "xmark").font(.title3.bold()).padding(10).background(.ultraThinMaterial, in: Circle()) }
                    Text(ctrl.title).font(.subheadline.weight(.semibold)).lineLimit(1).shadow(radius: 2)
                    Spacer()
                    Text(ctrl.status).font(.caption2).foregroundStyle(.secondary)
                }
                .padding()
                Spacer()
                if let s = ctrl.skipTitle {
                    HStack {
                        Spacer()
                        Button { ctrl.skip() } label: {
                            Label(s, systemImage: "forward.end.fill").font(.headline).padding(.horizontal, 16).padding(.vertical, 10)
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .padding(.trailing, 20).padding(.bottom, 110)
                    }
                }
            }
            #endif
            if let e = ctrl.error {
                VStack(spacing: 14) {
                    Text("Kunde inte spela").font(.headline)
                    Text(e).font(.footnote).foregroundStyle(.secondary)
                    Button("Stäng") { close() }.buttonStyle(.borderedProminent)
                }
                .padding(24).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private var subtitleFont: Font {
        #if os(tvOS)
        return .system(size: 44, weight: .semibold)
        #else
        return .system(size: 20, weight: .semibold)
        #endif
    }
    private var subtitleBottom: CGFloat {
        #if os(tvOS)
        return 90
        #else
        return 60
        #endif
    }
}
