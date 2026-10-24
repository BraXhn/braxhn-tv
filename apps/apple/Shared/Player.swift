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
    /// Bio-läge: titeln på trailern/förfilmen som spelas just nu (nil = filmen själv)
    @Published private(set) var prerollTitle: String?
    /// Nattläge/tydligare dialog kan väljas (strömmar från servern, inte nedladdade filer)
    @Published private(set) var canComfort = false
    @Published private(set) var night = false
    @Published private(set) var dialog = false

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

    /// Titeln som spelas just nu (sätts först när uppspelningen faktiskt startat)
    private var currentId: Int?
    private var localDuration: Double?
    private var isLocal = false
    private var intro: Marker?
    private var recap: Marker?
    private var credits: Double?
    /// Slutposition har inte rapporterats än för `currentId`
    private var reporting = false
    /// Servern har en strömningssession för `currentId` (gäller inte nedladdade filer)
    private var serverSession = false
    private var closed = false
    private var loadTask: Task<Void, Never>?
    /// Ökas för varje ny laddning – långsammare, ersatta laddningar ignoreras
    private var generation = 0
    // Bio-läge: kön med trailers och filmen som väntar på att kön blir klar
    private var prerollQueue: [URL] = []
    private var prerollTitles: [String] = []
    private var mainItem: AVPlayerItem?
    private var mainStart: Double = 0
    private var prerollObservers: [NSObjectProtocol] = []
    private var prerollStatus: NSKeyValueObservation?

    init(model: AppModel) {
        self.model = model
        night = model.nightMode
        dialog = model.clearDialog
        player.allowsExternalPlayback = true // AirPlay till Apple TV
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
    }

    /// Startar (eller byter till) en titel. En pågående laddning avbryts.
    func load(itemId: Int, at start: Double, audio: Int?, subtitle: SubtitleTrack?, cinema: Bool = true) {
        guard !closed else { return }
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            await self?.start(itemId: itemId, at: start, audio: audio, subtitle: subtitle, cinema: cinema)
        }
    }

    private func isLive(_ gen: Int) -> Bool { !closed && gen == generation && !Task.isCancelled }

    private func start(itemId: Int, at start: Double, audio: Int?, subtitle: SubtitleTrack?, cinema: Bool) async {
        guard !closed else { return }
        generation += 1
        let gen = generation
        AudioFocus.willPlay(.video)
        let stopping = stopReporting()
        #if os(iOS)
        // Nedladdad fil spelas direkt – utan att vänta på nätet
        if let local = Downloads.shared.localURL(for: itemId) {
            let rec = Downloads.shared.records.first { $0.id == itemId }
            resetState()
            currentId = itemId
            isLocal = true
            localDuration = rec?.duration
            self.audio = nil
            title = rec?.title ?? ""
            status = "Offline"
            player.replaceCurrentItem(with: AVPlayerItem(url: local))
            reporting = true
            if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
            guard isLive(gen) else { return }
            player.play()
            installObservers()
            // Metadata (titel, intro/eftertexter, undertexter) hämtas i bakgrunden om servern nås.
            // /playback anropas inte – det skulle starta en strömningssession på servern.
            guard let it: MediaItem = try? await model.get("/api/items/\(itemId)"), isLive(gen) else { return }
            item = it
            title = it.isEpisode ? "\(it.showTitle ?? "") · \(it.sxe) · \(it.title)" : it.title
            intro = it.intro
            recap = it.recap
            credits = it.credits
            let textSubs = (it.subtitles ?? []).filter { $0.bitmap != true }
            subtitleTracks = textSubs
            var sub = subtitle
            if sub == nil {
                sub = textSubs.first { $0.forced == true }
                    ?? textSubs.first { !model.subtitleLang.isEmpty && $0.lang == model.subtitleLang }
            }
            self.subtitle = sub
            selectedSubtitle = sub?.id ?? "none"
            if let s = sub { await loadCues(for: s, gen: gen) }
            return
        }
        #endif
        do {
            let it: MediaItem = try await model.get("/api/items/\(itemId)")
            guard isLive(gen) else { return }
            // Standardundertext om ingen valts
            var sub = subtitle
            if sub == nil, let subs = it.subtitles {
                sub = subs.first { $0.forced == true && $0.bitmap != true }
                    ?? subs.first { !model.subtitleLang.isEmpty && $0.lang == model.subtitleLang && $0.bitmap != true }
            }
            // Vänta tills föregående session stoppats så att stoppet inte når servern efter den nya starten
            await stopping?.value
            guard isLive(gen) else { return }
            let cinemaQ = await cinemaQuery(it, start: start, cinema: cinema)
            guard isLive(gen) else { return }
            let extra = model.comfortQuery() + cinemaQ
            let p: Playback = try await model.get("/api/items/\(itemId)/playback", model.capabilities(audio: audio, subtitle: sub) + extra)
            guard isLive(gen) else {
                // Ersatt eller stängd medan servern förberedde strömmen – stäng sessionen igen
                Task { [model] in try? await model.post("/api/stream/\(itemId)/stop") }
                return
            }
            guard let url = model.absolute(p.url) else { throw APIError(message: "Ogiltig ström-URL") }
            resetState()
            item = it
            pb = p
            currentId = itemId
            intro = p.intro
            recap = p.recap
            credits = p.credits
            self.audio = audio
            self.subtitle = sub
            title = it.isEpisode ? "\(it.showTitle ?? "") · \(it.sxe) · \(it.title)" : it.title
            subtitleTracks = it.subtitles ?? []
            selectedSubtitle = sub?.id ?? "none"
            audioTracks = p.audio ?? []
            chapters = p.chapters ?? []
            selectedAudio = p.audioSelected.flatMap { Int($0) } ?? audio
            status = [p.mode == "direct" ? "Direkt" : p.mode == "remux" ? "Remux" : "Omkodning",
                      p.tonemap == true ? "HDR→SDR" : nil, p.remote == true ? "utanför hemmet" : nil].compactMap { $0 }.joined(separator: " · ")
            let playerItem = AVPlayerItem(asset: AVURLAsset(url: url))
            playerItem.externalMetadata = metadata(it)
            #if os(tvOS)
            playerItem.navigationMarkerGroups = chapterMarkers(p.chapters ?? [])
            #endif
            serverSession = true
            canComfort = true
            // Bio-läge: trailers och förfilm först (filer som AVPlayer inte klarar hoppas över)
            let queue = (p.preroll ?? []).filter { !($0.mime ?? "").contains("matroska") && !($0.mime ?? "").contains("webm") }
            let urls = queue.compactMap { model.absolute($0.url) }
            if !urls.isEmpty, urls.count == queue.count {
                mainItem = playerItem
                mainStart = start
                prerollQueue = urls
                prerollTitles = queue.map { $0.title ?? ($0.kind == "preroll" ? "Förfilm" : "Trailer") }
                playNextPreroll()
                return
            }
            await startMain(playerItem, at: start, gen: gen)
        } catch {
            if isLive(gen) { self.error = error.localizedDescription }
        }
    }

    /// Startar själva filmen/avsnittet (direkt, eller när bio-lägets kö är slut)
    private func startMain(_ playerItem: AVPlayerItem, at start: Double, gen: Int) async {
        guard isLive(gen) else { return }
        player.replaceCurrentItem(with: playerItem)
        reporting = true
        if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
        guard isLive(gen) else { return }
        player.play()
        installObservers()
        if let s = subtitle { await loadCues(for: s, gen: gen) }
    }

    /// cinema=1 bara för filmer från början och när bio-läget är påslaget på servern (GET /api/me/cinema)
    private func cinemaQuery(_ it: MediaItem, start: Double, cinema: Bool) async -> [URLQueryItem] {
        guard cinema, it.kind == "movie", start < 1 else { return [] }
        let on = await model.cinemaEnabled()
        return on ? [URLQueryItem(name: "cinema", value: "1")] : []
    }

    // MARK: - bio-läge (trailers före filmen)

    private func playNextPreroll() {
        clearPrerollObservers()
        guard !closed else { return }
        guard !prerollQueue.isEmpty else { finishPreroll(); return }
        let url = prerollQueue.removeFirst()
        let name = prerollTitles.isEmpty ? "Trailer" : prerollTitles.removeFirst()
        let gen = generation
        let pi = AVPlayerItem(url: url)
        let oid = ObjectIdentifier(pi)
        prerollTitle = name
        skipTitle = "Hoppa över"
        player.replaceCurrentItem(with: pi)
        // Nästa post när den här är slut eller inte gick att spela
        let next: @Sendable () -> Void = { [weak self] in
            Task { @MainActor [weak self] in
                guard let s = self, s.generation == gen, let cur = s.player.currentItem, ObjectIdentifier(cur) == oid else { return }
                s.playNextPreroll()
            }
        }
        prerollObservers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: pi, queue: .main) { _ in next() })
        prerollObservers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: pi, queue: .main) { _ in next() })
        prerollStatus = pi.observe(\.status, options: [.new]) { item, _ in
            if item.status == .failed { next() }
        }
        player.play()
    }

    /// Kön är slut (eller Hoppa över alla): filmen startar
    private func finishPreroll() {
        clearPrerollObservers()
        prerollQueue = []
        prerollTitles = []
        prerollTitle = nil
        skipTitle = nil
        guard let main = mainItem else { return }
        mainItem = nil
        let gen = generation, at = mainStart
        Task { [weak self] in await self?.startMain(main, at: at, gen: gen) }
    }

    func skipAllPreroll() {
        guard prerollTitle != nil else { return }
        prerollQueue = []
        prerollTitles = []
        playNextPreroll()
    }

    private func clearPrerollObservers() {
        for o in prerollObservers { NotificationCenter.default.removeObserver(o) }
        prerollObservers = []
        prerollStatus?.invalidate()
        prerollStatus = nil
    }

    // MARK: - nattläge och tydligare dialog (servern filtrerar ljudet – kräver en ny ström)

    func toggleNight() {
        model.nightMode.toggle()
        night = model.nightMode
        restart(audio: audio, subtitle: subtitle)
    }

    func toggleDialog() {
        model.clearDialog.toggle()
        dialog = model.clearDialog
        restart(audio: audio, subtitle: subtitle)
    }

    /// Nollställer allt som hör till föregående titel
    private func resetState() {
        clearPrerollObservers()
        prerollQueue = []
        prerollTitles = []
        prerollTitle = nil
        mainItem = nil
        canComfort = false
        item = nil
        pb = nil
        isLocal = false
        localDuration = nil
        intro = nil
        recap = nil
        credits = nil
        cues = []
        subtitleText = ""
        skipTitle = nil
        error = nil
        audioTracks = []
        subtitleTracks = []
        chapters = []
        selectedAudio = nil
        selectedSubtitle = "none"
        subtitle = nil
        lastReport = Date()
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
        if !isLocal, s?.bitmap == true || subtitle?.bitmap == true { restart(audio: audio, subtitle: s); return }
        subtitle = s
        selectedSubtitle = s?.id ?? "none"
        cues = []
        subtitleText = ""
        if let s { let gen = generation; Task { await loadCues(for: s, gen: gen) } }
    }

    func seek(to chapter: Chapter) {
        player.seek(to: CMTime(seconds: chapter.start + 0.05, preferredTimescale: 600))
    }

    var currentChapter: Chapter? {
        let t = player.currentTime().seconds
        return chapters.last { $0.start <= t }
    }

    private func restart(audio: Int?, subtitle: SubtitleTrack?) {
        guard let id = currentId, !isLocal else { return }
        let t = prerollTitle != nil ? mainStart : player.currentTime().seconds
        load(itemId: id, at: t.isFinite ? t : 0, audio: audio, subtitle: subtitle, cinema: false)
    }

    private func loadCues(for s: SubtitleTrack, gen: Int) async {
        guard s.bitmap != true else { return }
        var data: Data?
        if let ps = pb?.subtitles.first(where: { $0.id == s.id }), let url = model.absolute(ps.url) {
            data = try? await URLSession.shared.data(from: url).0
        } else if isLocal, let id = currentId {
            data = try? await model.data("/api/stream/\(id)/subs/\(s.id).vtt")
        }
        guard isLive(gen), subtitle?.id == s.id, let d = data, let txt = String(data: d, encoding: .utf8) else { return }
        cues = VTT.parse(txt)
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

    private var duration: Double { pb?.duration ?? item?.duration ?? localDuration ?? 0 }

    private func tick(_ t: Double) {
        guard t.isFinite, !closed, prerollTitle == nil else { return }
        // Undertexter
        let st = t - subtitleOffset
        if let c = cues.last(where: { $0.start <= st }), st <= c.end { if subtitleText != c.text { subtitleText = c.text } }
        else if !subtitleText.isEmpty { subtitleText = "" }
        // Hoppa över intro / nästa avsnitt
        var skip: String?
        if let r = recap, t >= r.start, t < r.end - 1 { skip = "Hoppa över sammanfattning" }
        else if let i = intro, t >= i.start, t < i.end - 1 { skip = "Hoppa över intro" }
        else if let c = credits, item?.nextId != nil, t >= c, t < c + 60 { skip = "Nästa avsnitt" }
        if skip != skipTitle { skipTitle = skip }
        // Tittarstatus var 10:e sekund
        if reporting, Date().timeIntervalSince(lastReport) > 10, t > 1, let id = currentId {
            lastReport = Date()
            model.reportProgress(id: id, position: t, duration: duration)
        }
    }

    func skip() {
        guard let t = skipTitle else { return }
        if prerollTitle != nil { playNextPreroll(); return }
        if t == "Hoppa över sammanfattning", let r = recap {
            player.seek(to: CMTime(seconds: r.end, preferredTimescale: 600))
        } else if t == "Hoppa över intro", let i = intro {
            player.seek(to: CMTime(seconds: i.end, preferredTimescale: 600))
        } else if let next = item?.nextId {
            load(itemId: next, at: 0, audio: nil, subtitle: nil)
        }
    }

    private func ended() {
        guard !closed else { return }
        stopReporting()
        if let next = item?.nextId { load(itemId: next, at: 0, audio: nil, subtitle: nil) }
        else { onFinished?() }
    }

    /// Rapporterar slutposition och stänger serverns session – högst en gång per titel.
    @discardableResult
    private func stopReporting() -> Task<Void, Never>? {
        guard reporting || serverSession, let id = currentId else { return nil }
        if reporting {
            reporting = false
            let t = player.currentTime().seconds
            if t.isFinite, t > 1 { model.reportProgress(id: id, position: t, duration: duration) }
        }
        guard serverSession else { return nil }
        serverSession = false
        return Task { [model] in _ = try? await model.post("/api/stream/\(id)/stop") }
    }

    /// Stänger spelaren. Kan anropas flera gånger (både från Stäng-knappen och onDisappear).
    func close() {
        guard !closed else { return }
        closed = true
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        onFinished = nil
        stopReporting()
        clearPrerollObservers()
        mainItem = nil
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
            var actions = [UIAction(title: t, image: UIImage(systemName: "forward.end.fill")) { _ in onSkip() }]
            if ctrl.prerollTitle != nil {
                actions.append(UIAction(title: "Hoppa över alla", image: UIImage(systemName: "forward.fill")) { _ in ctrl.skipAllPreroll() })
            }
            vc.contextualActions = actions
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
        if ctrl.canComfort {
            menus.append(UIMenu(title: "Ljudläge", image: UIImage(systemName: "moon"), children: [
                UIAction(title: "Nattläge", state: ctrl.night ? .on : .off) { _ in ctrl.toggleNight() },
                UIAction(title: "Tydligare dialog", state: ctrl.dialog ? .on : .off) { _ in ctrl.toggleDialog() }
            ]))
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
                // Svag referens: kontrollern får inte hålla kvar vyn/holdern (retain-cykel)
                let dismissAction = dismiss
                let h = holder
                c.onFinished = { [weak h] in
                    h?.ctrl?.close()
                    dismissAction()
                }
                holder.ctrl = c
                c.load(itemId: request.itemId, at: request.start, audio: request.audio, subtitle: request.subtitle)
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
                    if ctrl.audioTracks.count > 1 || !ctrl.subtitleTracks.isEmpty || !ctrl.chapters.isEmpty || ctrl.canComfort {
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
                            if ctrl.canComfort {
                                Button { ctrl.toggleNight() } label: { Label("Nattläge", systemImage: ctrl.night ? "checkmark" : "moon") }
                                Button { ctrl.toggleDialog() } label: { Label("Tydligare dialog", systemImage: ctrl.dialog ? "checkmark" : "person.wave.2") }
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
                        if let pt = ctrl.prerollTitle {
                            Text(pt).font(.caption).lineLimit(1).padding(.horizontal, 10).padding(.vertical, 6)
                                .background(.ultraThinMaterial, in: Capsule()).padding(.bottom, 110)
                            Button { ctrl.skipAllPreroll() } label: {
                                Text("Hoppa över alla").font(.headline).padding(.horizontal, 16).padding(.vertical, 10)
                                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
                            }
                            .padding(.bottom, 110)
                        }
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
