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
    @Published var audioTracks: [AudioStream] = []
    @Published var subtitleTracks: [SubtitleTrack] = []
    @Published var chapters: [Chapter] = []
    @Published var selectedAudio: Int?
    @Published var selectedSubtitle: String = "none"

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
        #if os(iOS)
        // Utan kontakt med servern: spela nedladdad fil direkt
        if let local = Downloads.shared.localURL(for: itemId) {
            let online: ServerStatus? = try? await model.get("/api/status")
            if online == nil {
                title = Downloads.shared.records.first { $0.id == itemId }?.title ?? ""
                status = "Offline"
                player.replaceCurrentItem(with: AVPlayerItem(url: local))
                if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
                player.play()
                return
            }
        }
        #endif
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
            subtitleTracks = it.subtitles ?? []
            selectedSubtitle = sub?.id ?? "none"
            #if os(iOS)
            // Nedladdad fil spelas lokalt (fungerar utan nät)
            if let local = Downloads.shared.localURL(for: itemId) {
                status = "Offline"
                let playerItem = AVPlayerItem(url: local)
                player.replaceCurrentItem(with: playerItem)
                if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
                player.play()
                pb = try? await model.get("/api/items/\(itemId)/playback", model.capabilities(audio: audio, subtitle: sub))
                installObservers()
                return
            }
            #endif
            let p: Playback = try await model.get("/api/items/\(itemId)/playback", model.capabilities(audio: audio, subtitle: sub))
            pb = p
            audioTracks = p.audio ?? []
            chapters = p.chapters ?? []
            selectedAudio = p.audioSelected.flatMap { Int($0) } ?? audio
            status = [p.mode == "direct" ? "Direkt" : p.mode == "remux" ? "Remux" : "Omkodning",
                      p.tonemap == true ? "HDR→SDR" : nil, p.remote == true ? "utanför hemmet" : nil].compactMap { $0 }.joined(separator: " · ")
            guard let url = model.absolute(p.url) else { throw APIError(message: "Ogiltig ström-URL") }
            let asset = AVURLAsset(url: url)
            let playerItem = AVPlayerItem(asset: asset)
            playerItem.externalMetadata = metadata(it)
            #if os(tvOS)
            playerItem.navigationMarkerGroups = chapterMarkers(p.chapters ?? [])
            #endif
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

    #if os(tvOS)
    /// Kapitel visas i Apple TV:s egen spelare (svep nedåt → Kapitel)
    private func chapterMarkers(_ ch: [Chapter]) -> [AVNavigationMarkersGroup] {
        guard !ch.isEmpty else { return [] }
        let groups = ch.map { c -> AVTimedMetadataGroup in
            let t = AVMutableMetadataItem()
            t.identifier = .commonIdentifierTitle
            t.value = c.title as NSString
            t.extendedLanguageTag = "und"
            let range = CMTimeRange(start: CMTime(seconds: c.start, preferredTimescale: 600), end: CMTime(seconds: max(c.end, c.start + 1), preferredTimescale: 600))
            return AVTimedMetadataGroup(items: [t], timeRange: range)
        }
        return [AVNavigationMarkersGroup(title: nil, timedNavigationMarkers: groups)]
    }
    #endif

    // MARK: - byte av spår under uppspelning
    func selectAudio(_ index: Int) {
        guard index != selectedAudio else { return }
        restart(audio: index, subtitle: subtitle)
    }

    func selectSubtitle(_ id: String) {
        let s = subtitleTracks.first { $0.id == id }
        model.subtitleLang = s?.lang ?? ""
        // Bildundertexter bränns in av servern och kräver en ny ström; textundertexter byts direkt
        if s?.bitmap == true || subtitle?.bitmap == true { restart(audio: audio, subtitle: s); return }
        subtitle = s
        selectedSubtitle = s?.id ?? "none"
        cues = []
        subtitleText = ""
        if let s, let ps = pb?.subtitles.first(where: { $0.id == s.id }) { Task { await loadCues(ps) } }
    }

    func seek(to chapter: Chapter) {
        player.seek(to: CMTime(seconds: chapter.start + 0.05, preferredTimescale: 600))
    }

    var currentChapter: Chapter? {
        let t = player.currentTime().seconds
        return chapters.last { $0.start <= t }
    }

    private func restart(audio: Int?, subtitle: SubtitleTrack?) {
        guard let it = item else { return }
        let t = player.currentTime().seconds
        Task { await start(itemId: it.id, at: t.isFinite ? t : 0, audio: audio, subtitle: subtitle) }
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
    @ObservedObject var ctrl: PlayerController

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
        // Ljud och undertexter i spelarens menyrad (svep nedåt på fjärrkontrollen)
        var menus: [UIMenuElement] = []
        if ctrl.audioTracks.count > 1 {
            menus.append(UIMenu(title: "Ljud", image: UIImage(systemName: "speaker.wave.2"), options: .singleSelection, children: ctrl.audioTracks.map { a in
                UIAction(title: a.label, state: a.index == ctrl.selectedAudio ? .on : .off) { _ in ctrl.selectAudio(a.index) }
            }))
        }
        if !ctrl.subtitleTracks.isEmpty {
            let none = UIAction(title: "Inga", state: ctrl.selectedSubtitle == "none" ? .on : .off) { _ in ctrl.selectSubtitle("none") }
            menus.append(UIMenu(title: "Undertexter", image: UIImage(systemName: "captions.bubble"), options: .singleSelection, children: [none] + ctrl.subtitleTracks.map { s in
                UIAction(title: s.label, state: s.id == ctrl.selectedSubtitle ? .on : .off) { _ in ctrl.selectSubtitle(s.id) }
            }))
        }
        vc.transportBarCustomMenuItems = menus
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
            PlayerVC(player: ctrl.player, skipTitle: ctrl.skipTitle, onSkip: { ctrl.skip() }, ctrl: ctrl)
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
                    if ctrl.audioTracks.count > 1 || !ctrl.subtitleTracks.isEmpty || !ctrl.chapters.isEmpty {
                        Menu {
                            if ctrl.audioTracks.count > 1 {
                                Picker("Ljud", selection: Binding(get: { ctrl.selectedAudio ?? -1 }, set: { ctrl.selectAudio($0) })) {
                                    ForEach(ctrl.audioTracks) { a in Text(a.label).tag(a.index) }
                                }
                                .pickerStyle(.menu)
                            }
                            if !ctrl.subtitleTracks.isEmpty {
                                Picker("Undertexter", selection: Binding(get: { ctrl.selectedSubtitle }, set: { ctrl.selectSubtitle($0) })) {
                                    Text("Inga").tag("none")
                                    ForEach(ctrl.subtitleTracks) { s in Text(s.label).tag(s.id) }
                                }
                                .pickerStyle(.menu)
                            }
                            if !ctrl.chapters.isEmpty {
                                Menu("Kapitel") {
                                    ForEach(ctrl.chapters) { c in
                                        Button { ctrl.seek(to: c) } label: { Text("\(c.title)  \(Self.fmt(c.start))") }
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: "list.bullet.rectangle").font(.title3).padding(10).background(.ultraThinMaterial, in: Circle())
                        }
                    }
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

    static func fmt(_ s: Double) -> String {
        let t = Int(s), h = t / 3600, m = (t % 3600) / 60, sec = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
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
