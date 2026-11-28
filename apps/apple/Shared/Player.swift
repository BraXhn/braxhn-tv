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
    /// Felet som visas. Feedback förvalt "Något fungerar inte" en halvtimme efter ett fel (FeedbackTracker).
    @Published var error: String? { didSet { if let e = error { FeedbackTracker.shared.notePlayback(currentId ?? 0, error: e) } } }
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
    /// Strömmen förbereds (servern startar omkodningen) – sätts tills bilden faktiskt rör sig
    @Published private(set) var preparing = false
    /// Förberedelsen har tagit mer än några sekunder (t.ex. grafikkortets ~10 s till första segmentet) – visa varför
    @Published private(set) var slowStart = false
    /// Servern stoppade uppspelningen (Föräldraöversikten, administratören eller skärmtiden) – texten som visas
    @Published private(set) var stopNotice: String?
    /// Felet kan försökas igen (strömmen avbröts under uppspelningen)
    @Published private(set) var canRetry = false
    /// Avsnittet är slut och nästa startar om så här många sekunder (kortet med Spela nu och Avbryt; NextCore). nil = inget kort
    @Published private(set) var nextIn: Int?
    /// Skärmtiden kvar idag (ScreenLeftCore): först appens senast kända status, sedan serverns svar på varje
    /// framstegsrapport och utan nät appens egen räkning. nil = ingen skärmtid eller ingen gräns idag. VoiceOver läser
    /// upp varningen när den syns och när minuten ändras.
    @Published private(set) var screenLeft: ScreenLeftCore.Left? {
        didSet {
            guard ScreenLeftCore.announce(from: oldValue, to: screenLeft), let l = screenLeft else { return }
            UIAccessibility.post(notification: .announcement, argument: ScreenLeftCore.texts(l, compact: false, tr: L).warn)
        }
    }
    /// Filmen är pausad (Apple TV visar då tiden kvar, som när spelarens reglage syns)
    @Published private(set) var paused = false

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
    // Själva filmens AVPlayerItem: fel bevakas så att en långsam start inte blir en svart skärm
    private var mainURL: URL?
    private var mainMeta: [AVMetadataItem] = []
    private var mainStatus: NSKeyValueObservation?
    private var mainFail: NSObjectProtocol?
    private var timeControl: NSKeyValueObservation?
    /// Bilden har rört sig för den här starten (efter det försöker appen inte längre själv igen)
    private var playbackBegan = false
    /// Nya försök med samma ström-URL (samma session på servern) under starten
    private var retries = 0
    /// Hemadressen slutade gälla (Hemma.swift) – filmen byter adress
    private var homeObserver: NSObjectProtocol?
    // Spolning i en omkodning (SeekCore, seekRestart nedan): strömmens segment och mätningar, omstarten som väntar på
    // fler steg från fjärrkontrollen, frågorna om vad servern har klart (/hls/ready), omstartens nummer (en äldre som
    // blir klar senare tar inte över) och om en omstart pågår (då är den gamla strömmen stoppad på servern och dess fel
    // ska inte visas)
    private var seekWatch: SeekCore.Watch?
    private var settleTask: Task<Void, Never>?
    private var readyTask: Task<Void, Never>?
    /// Nedladdad titel: sekunder som spelats sedan förra framsteget och förra mätningen (systemets uptime). Kommer
    /// framsteget inte fram (inget nät) räknas tiden som skärmtid i appen (OfflineScreen).
    private var localPlayed: Double = 0
    private var localBeat: Double?
    /// Nedladdad titel: uppspelningens id för tiden som lämnas in i efterhand (PendingScreenTime, en post per uppspelning)
    private var localPlay = ""
    private var seekGen = 0
    private var seekRestarting = false
    /// Nedräkningen till nästa avsnitt (kortet när avsnittet är slut)
    private var nextTask: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model
        night = model.nightMode
        dialog = model.clearDialog
        player.allowsExternalPlayback = true // AirPlay till Apple TV
        homeObserver = NotificationCenter.default.addObserver(forName: .homeLeft, object: model, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.homeLeft() }
        }
        // När bilden börjar röra sig är förberedelsen klar
        timeControl = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            let playing = p.timeControlStatus == .playing
            let paused = p.timeControlStatus == .paused
            Task { @MainActor [weak self] in
                self?.paused = paused
                self?.playStateChanged(playing)
            }
        }
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
    }

    /// Startar (eller byter till) en titel. En pågående laddning avbryts.
    func load(itemId: Int, at start: Double, audio: Int?, subtitle: SubtitleTrack?, cinema: Bool = true) {
        guard !closed else { return }
        // Titeln i Feedbacks tekniska information (servern lägger till namn och format)
        FeedbackTracker.shared.notePlayback(itemId, error: nil)
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
        // Tiden kvar direkt: appens senast kända status och tiden som räknats utan nät (iPhone/iPad sparar serverns
        // svar, OfflineScreen); serverns svar tar över efter tio sekunder. Apple TV sparar inget: förra avsnittets står kvar.
        if let l = ScreenLeftCore.ofGate(OfflineScreen.gateNow(model)) { screenLeft = l }
        #if os(iOS)
        // Nedladdad fil spelas direkt – utan att vänta på nätet
        if let local = Downloads.shared.localURL(for: itemId) {
            let rec = Downloads.shared.records.first { $0.id == itemId }
            resetState()
            currentId = itemId
            isLocal = true
            localPlay = UUID().uuidString
            localDuration = rec?.duration
            self.audio = nil
            title = rec?.title ?? ""
            status = "Offline"
            // Skärmtiden först, utan att vänta på nätet: den senaste statusen från servern och tiden som spelats utan
            // nät sedan dess (OfflineScreen). Säger den nej frågas servern (en vuxen kan ha gett mer tid); svarar den
            // inte gäller den sparade.
            var gate = OfflineScreen.gateNow(model)
            if !gate.allowed, await OfflineScreen.refresh(model) { gate = OfflineScreen.gateNow(model) }
            guard isLive(gen) else { return }
            if !gate.allowed { stopNotice = OfflineScreen.message(gate); return }
            screenLeft = ScreenLeftCore.ofGate(gate)
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
        beginPreparing(gen: gen)
        retries = 0
        do {
            // Titelns uppgifter hämtas redan medan ett stopp av förra strömmen går iväg
            let itemTask = Task { [model] () async throws -> MediaItem in try await model.get("/api/items/\(itemId)") }
            // Vänta tills föregående session stoppats så att stoppet inte når servern efter den nya starten
            await stopping?.value
            guard isLive(gen) else { return }
            // Titelns uppgifter och /playback samtidigt (StartCore.together): frågan behöver inget ur titelns svar.
            // Samma fråga som förvärmningen på titelsidan (Start.query), så att servern tar över den strömmen.
            // start: servern förstartar omkodningen där uppspelningen börjar; cinema=1 vid start från början – servern
            // ger trailers bara för filmer och när bio-läget är på. Undertexten väljs nedan ur titelns spårlista, men
            // en textundertext skickas aldrig till servern (bara en bildundertext som användaren valt).
            let q = Start.query(model, audio: audio, subtitle: subtitle, start: start, cinema: cinema)
            let (it, p): (MediaItem, Playback) = try await StartCore.together(
                item: { try await itemTask.value },
                playback: { [model] () async throws -> Playback in try await model.get("/api/items/\(itemId)/playback", q) },
                drop: { [model] (np: Playback) in await Start.drop(model, id: itemId, np) })
            guard isLive(gen) else {
                // Ersatt eller stängd medan servern förberedde strömmen – stäng den strömmen igen (pid: inte en nyare)
                Task { [model] in await Start.drop(model, id: itemId, p) }
                return
            }
            // Standardundertext om ingen valts (textundertexter: spelaren visar dem själv)
            var sub = subtitle
            if sub == nil, let subs = it.subtitles {
                sub = subs.first { $0.forced == true && $0.bitmap != true }
                    ?? subs.first { !model.subtitleLang.isEmpty && $0.lang == model.subtitleLang && $0.bitmap != true }
            }
            // xs: spellistan säger var uppspelningen börjar (EXT-X-START) – även på Apple TV (SeekCore.withStart)
            guard let url = model.absolute(p.mode == "direct" ? p.url : SeekCore.withStart(p.url, at: start)) else { throw APIError(message: L("Ogiltig ström-URL")) }
            resetState()
            beginPreparing(gen: gen)
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
            status = [p.mode == "direct" ? L("Direkt") : p.mode == "remux" ? L("Remux") : L("Omkodning"),
                      p.tonemap == true ? "HDR→SDR" : nil, p.remote == true ? L("utanför hemmet") : nil].compactMap { $0 }.joined(separator: " · ")
            mainURL = url
            mainMeta = metadata(it)
            let playerItem = makeMainItem(url)
            serverSession = true
            canComfort = true
            if p.mode == "transcode" { watchStream(url, from: start) }
            // Bio-läge: trailers och förfilm först (filer som AVPlayer inte klarar hoppas över)
            let queue = (p.preroll ?? []).filter { !($0.mime ?? "").contains("matroska") && !($0.mime ?? "").contains("webm") }
            let urls = queue.compactMap { model.absolute($0.url) }
            if !urls.isEmpty, urls.count == queue.count {
                mainItem = playerItem
                mainStart = start
                prerollQueue = urls
                prerollTitles = queue.map { $0.title ?? ($0.kind == "preroll" ? L("Förfilm") : L("Trailer")) }
                playNextPreroll()
                return
            }
            await startMain(playerItem, at: start, gen: gen)
        } catch {
            if isLive(gen), !isCancellation(error) {
                preparing = false
                slowStart = false
                self.error = error.localizedDescription
            }
        }
    }

    /// Startar själva filmen/avsnittet (direkt, eller när bio-lägets kö är slut)
    private func startMain(_ playerItem: AVPlayerItem, at start: Double, gen: Int, play: Bool = true) async {
        guard isLive(gen) else { return }
        mainStart = start
        playbackBegan = false
        beginPreparing(gen: gen)
        watchMain(playerItem, gen: gen)
        player.replaceCurrentItem(with: playerItem)
        reporting = true
        if start > 1 { _ = await player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
        guard isLive(gen) else { return }
        // Pausad film förblir pausad efter en omstart vid spolning (då är bilden där och inget förbereds längre)
        if play { player.play() } else { preparing = false; slowStart = false }
        installObservers()
        if let s = subtitle { await loadCues(for: s, gen: gen) }
    }

    // MARK: - bio-läge (trailers före filmen)

    private func playNextPreroll() {
        clearPrerollObservers()
        guard !closed else { return }
        guard !prerollQueue.isEmpty else { finishPreroll(); return }
        let url = prerollQueue.removeFirst()
        let name = prerollTitles.isEmpty ? L("Trailer") : prerollTitles.removeFirst()
        let gen = generation
        let pi = AVPlayerItem(url: url)
        let oid = ObjectIdentifier(pi)
        prerollTitle = name
        skipTitle = SkipKind.preroll
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
        clearMainObservers()
        mainURL = nil
        mainMeta = []
        stopNotice = nil
        canRetry = false
        preparing = false
        slowStart = false
        playbackBegan = false
        settleTask?.cancel()
        settleTask = nil
        readyTask?.cancel()
        readyTask = nil
        seekWatch = nil
        seekGen += 1
        seekRestarting = false
        localPlayed = 0
        localBeat = nil
        nextTask?.cancel()
        nextTask = nil
        nextIn = nil
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
        // Före första bilden (eller efter ett fel) är spelarens tid inte att lita på – starta där filmen skulle börja
        let t = prerollTitle != nil || !playbackBegan ? mainStart : player.currentTime().seconds
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
        // Spolning i en omkodning: ett hopp utanför bufferten startar om strömmen vid målet
        if seekWatch != nil, !seekRestarting { observeSeek(t) }
        // Nedladdad titel: tiden som spelas (räknas som skärmtid om framsteget inte kommer fram)
        if isLocal { countLocal() }
        // Undertexter
        let st = t - subtitleOffset
        if let c = cues.last(where: { $0.start <= st }), st <= c.end { if subtitleText != c.text { subtitleText = c.text } }
        else if !subtitleText.isEmpty { subtitleText = "" }
        // Hoppa över intro / nästa avsnitt
        var skip: String?
        if let r = recap, t >= r.start, t < r.end - 1 { skip = SkipKind.recap }
        else if let i = intro, t >= i.start, t < i.end - 1 { skip = SkipKind.intro }
        else if let c = credits, item?.nextId != nil, t >= c, t < c + 60 { skip = SkipKind.next }
        if skip != skipTitle { skipTitle = skip }
        // Eftertexterna går: nästa avsnitt förvärms (och hålls varmt) redan nu, som webben
        if NextCore.warmsNext(skip: skip, nextKind: SkipKind.next) { warmNext() }
        // Tittarstatus var 10:e sekund
        if reporting, Date().timeIntervalSince(lastReport) > 10, t > 1, let id = currentId {
            lastReport = Date()
            let gen = generation
            let secs = takeLocalPlayed()
            let play = localPlay
            var noAnswer: (() -> Void)?
            if isLocal {
                noAnswer = { [weak self] in
                    Task { @MainActor [weak self] in self?.playedOffline(secs, play: play, id: id, gen: gen) }
                }
            }
            model.reportProgress(id: id, position: t, duration: duration, onStop: { [weak self] r in
                Task { @MainActor [weak self] in self?.stoppedByServer(r, id: id, gen: gen) }
            }, noAnswer: noAnswer, onScreen: { [weak self] st in
                Task { @MainActor [weak self] in self?.screenFromServer(st, id: id, gen: gen) }
            })
        }
    }

    func skip() {
        guard let t = skipTitle else { return }
        if prerollTitle != nil { playNextPreroll(); return }
        if t == SkipKind.recap, let r = recap {
            player.seek(to: CMTime(seconds: r.end, preferredTimescale: 600))
        } else if t == SkipKind.intro, let i = intro {
            player.seek(to: CMTime(seconds: i.end, preferredTimescale: 600))
        } else if let next = item?.nextId {
            load(itemId: next, at: 0, audio: nil, subtitle: nil)
        }
    }

    /// Avsnittet är slut: kontots val Spela nästa avsnitt automatiskt (autoNext i /playback, NextCore.end). Av eller
    /// inget nästa avsnitt: spelaren stängs. 0 s: nästa direkt. Annars kortet "Nästa avsnitt om N s".
    private func ended() {
        guard !closed, nextIn == nil else { return }
        stopReporting()
        switch NextCore.end(pb?.autoNext, hasNext: item?.nextId != nil) {
        case .close: onFinished?()
        case .next: playNext()
        case .card(let seconds): showNext(seconds)
        }
    }

    /// Rapporterar slutposition och stänger serverns session – högst en gång per titel.
    @discardableResult
    private func stopReporting() -> Task<Void, Never>? {
        guard reporting || serverSession, let id = currentId else { return nil }
        if reporting {
            reporting = false
            let t = player.currentTime().seconds
            let secs = takeLocalPlayed()
            let play = localPlay
            // Nedladdad titel utan nät: den sista biten räknas också som skärmtid (stoppar inget, spelaren stängs)
            var noAnswer: (() -> Void)?
            if isLocal {
                noAnswer = { [model] in
                    Task { @MainActor in _ = OfflineScreen.played(model, seconds: secs, play: play) }
                }
            }
            if t.isFinite, t > 1 { model.reportProgress(id: id, position: t, duration: duration, noAnswer: noAnswer) }
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
        settleTask?.cancel()
        settleTask = nil
        readyTask?.cancel()
        readyTask = nil
        nextTask?.cancel()
        nextTask = nil
        onFinished = nil
        stopReporting()
        clearPrerollObservers()
        clearMainObservers()
        timeControl?.invalidate()
        timeControl = nil
        mainItem = nil
        player.pause()
        if let o = observer { player.removeTimeObserver(o); observer = nil }
        if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
        if let h = homeObserver { NotificationCenter.default.removeObserver(h); homeObserver = nil }
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
            var actions = [UIAction(title: L(t), image: UIImage(systemName: "forward.end.fill")) { _ in onSkip() }]
            if ctrl.prerollTitle != nil {
                actions.append(UIAction(title: L("Hoppa över alla"), image: UIImage(systemName: "forward.fill")) { _ in ctrl.skipAllPreroll() })
            }
            vc.contextualActions = actions
        } else {
            vc.contextualActions = []
        }
        // Ljud och undertexter i spelarens menyrad (svep nedåt på fjärrkontrollen)
        var menus: [UIMenuElement] = []
        if ctrl.audioTracks.count > 1 {
            menus.append(UIMenu(title: L("Ljud"), image: UIImage(systemName: "speaker.wave.2"), options: .singleSelection, children: ctrl.audioTracks.map { a in
                UIAction(title: a.label, state: a.index == ctrl.selectedAudio ? .on : .off) { _ in ctrl.selectAudio(a.index) }
            }))
        }
        if !ctrl.subtitleTracks.isEmpty {
            let none = UIAction(title: L("Inga"), state: ctrl.selectedSubtitle == "none" ? .on : .off) { _ in ctrl.selectSubtitle("none") }
            menus.append(UIMenu(title: L("Undertexter"), image: UIImage(systemName: "captions.bubble"), options: .singleSelection, children: [none] + ctrl.subtitleTracks.map { s in
                UIAction(title: s.label, state: s.id == ctrl.selectedSubtitle ? .on : .off) { _ in ctrl.selectSubtitle(s.id) }
            }))
        }
        if ctrl.canComfort {
            menus.append(UIMenu(title: L("Ljudläge"), image: UIImage(systemName: "moon"), children: [
                UIAction(title: L("Nattläge"), state: ctrl.night ? .on : .off) { _ in ctrl.toggleNight() },
                UIAction(title: L("Tydligare dialog"), state: ctrl.dialog ? .on : .off) { _ in ctrl.toggleDialog() }
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
        .feedbackPage("Spelaren")
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
    @EnvironmentObject var model: AppModel
    @ObservedObject var ctrl: PlayerController
    let close: () -> Void
    /// Rapportera felet: Feedback med Något fungerar inte och Uppspelning förvalt
    @State private var report = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        ZStack {
            // Vid fel eller stopp (och på Apple TV medan kortet för nästa avsnitt syns) tas spelarvyn bort: på Apple TV
            // får rutans knappar då fokus (annars behåller AVPlayerViewController fokus och Stäng/Försök igen/Spela nu går
            // inte att nå med fjärrkontrollen)
            if ctrl.error == nil && ctrl.stopNotice == nil && !cardTakesFocus {
                PlayerVC(player: ctrl.player, skipTitle: ctrl.skipTitle, onSkip: { ctrl.skip() }, ctrl: ctrl)
                    .ignoresSafeArea()
            }
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
                    // Skärmtiden kvar idag (kort text på en smal skärm, som webben på telefonen)
                    if let l = ctrl.screenLeft, ctrl.stopNotice == nil {
                        leftPill(ScreenLeftCore.texts(l, compact: sizeClass == .compact, tr: L).pill, low: l.warn)
                    }
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
                if let s = ctrl.skipTitle, ctrl.nextIn == nil {
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
                            Label(L(s), systemImage: "forward.end.fill").font(.headline).padding(.horizontal, 16).padding(.vertical, 10)
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .padding(.trailing, 20).padding(.bottom, 110)
                    }
                }
            }
            #endif
            #if os(tvOS)
            // Apple TV: tiden kvar när filmen är pausad (då syns spelarens egna reglage)
            if let l = ctrl.screenLeft, ctrl.paused, ctrl.error == nil, ctrl.stopNotice == nil, ctrl.nextIn == nil {
                VStack {
                    HStack {
                        Spacer()
                        leftPill(ScreenLeftCore.texts(l, compact: false, tr: L).pill, low: l.warn)
                    }
                    Spacer()
                }
                .padding(.top, 50).padding(.trailing, 80)
                .allowsHitTesting(false)
            }
            #endif
            // Varningen de sista fem minuterna, även när filmen spelar. Texten byts bara när minuten ändras, och
            // VoiceOver läser upp den då (PlayerController.screenLeft)
            if let l = ctrl.screenLeft, l.warn, ctrl.error == nil, ctrl.stopNotice == nil {
                VStack {
                    Text(ScreenLeftCore.texts(l, compact: false, tr: L).warn)
                        .font(.headline).foregroundStyle(.black)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Self.lowTime, in: Capsule())
                        .padding(.top, warnTop)
                    Spacer()
                }
                .allowsHitTesting(false)
            }
            // Avsnittet är slut: nästa avsnitt om N s, med Spela nu och Avbryt (NextCore)
            if let n = ctrl.nextIn, ctrl.error == nil, ctrl.stopNotice == nil {
                NextCard(seconds: n, play: { ctrl.playNext() }, cancel: { ctrl.cancelNext() })
            }
            if ctrl.slowStart && ctrl.error == nil && ctrl.stopNotice == nil {
                // Omkodning med grafikkort kan ta ~10 s till första bilden – säg det, så att ingen startar om
                VStack {
                    Spacer()
                    Text("Servern förbereder strömmen – det kan ta några sekunder…")
                        .font(.callout).multilineTextAlignment(.center)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 40).padding(.horizontal)
                }
                .allowsHitTesting(false)
            }
            if let n = ctrl.stopNotice {
                VStack(spacing: 14) {
                    Image(systemName: "hand.raised.fill").font(.largeTitle)
                    Text("Uppspelningen stoppades").font(.headline)
                    Text(n).font(.body).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Stäng") { close() }.buttonStyle(.borderedProminent)
                }
                .padding(24).frame(maxWidth: 640).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            } else if let e = ctrl.error {
                VStack(spacing: 14) {
                    Text("Kunde inte spela").font(.headline)
                    Text(e).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    HStack(spacing: 16) {
                        if ctrl.canRetry { Button("Försök igen") { ctrl.retry() }.buttonStyle(.borderedProminent) }
                        Button("Stäng") { close() }.buttonStyle(.bordered)
                    }
                    // Egen rad: tre knappar får inte plats bredvid varandra på Apple TV
                    Button("Rapportera felet") { report = true }.buttonStyle(.bordered)
                }
                .padding(24).frame(maxWidth: 640).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                .sheet(isPresented: $report) { FeedbackSheet(kind: "bug", area: "uppspelning").environmentObject(model) }
            }
        }
    }

    static func fmt(_ s: Double) -> String { formatTime(s) }

    /// Varningens färg (som Android-appens LowTime och webbens .low)
    static let lowTime = Color(red: 1, green: 0.78, blue: 0.35)

    /// Apple TV: kortet med Spela nu tar bort spelarvyn medan det syns, annars behåller AVPlayerViewController fokus och
    /// knapparna går inte att nå med fjärrkontrollen (som vid fel och stopp)
    private var cardTakesFocus: Bool {
        #if os(tvOS)
        return ctrl.nextIn != nil
        #else
        return false
        #endif
    }

    /// Tiden kvar idag i spelarens överkant (i varningens färg de sista fem minuterna)
    private func leftPill(_ text: String, low: Bool) -> some View {
        Text(text)
            .font(.caption.weight(.semibold)).lineLimit(1)
            .foregroundStyle(low ? Self.lowTime : .white)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Color.black.opacity(0.5), in: Capsule())
    }

    private var warnTop: CGFloat {
        #if os(tvOS)
        return 60
        #else
        return 64
        #endif
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

/// Kortet när avsnittet är slut: "Nästa avsnitt om N s" med Spela nu och Avbryt (NextCore.swift, som webben och
/// Expo-appen). Apple TV: fokus på Spela nu när kortet visas, fjärrkontrollens Menu = Avbryt.
struct NextCard: View {
    let seconds: Int
    let play: () -> Void
    let cancel: () -> Void
    @FocusState private var focusPlay: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(String(format: L("Nästa avsnitt om %d s"), max(0, seconds)))
                .font(.headline)
                .monospacedDigit()
            HStack(spacing: 16) {
                Button(action: play) { Label("Spela nu", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
                    .focused($focusPlay)
                Button("Avbryt", action: cancel)
                    .buttonStyle(.bordered)
            }
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.trailing, edge).padding(.bottom, edge)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        #if os(tvOS)
        .onExitCommand(perform: cancel)
        #endif
        // Fokus (Apple TV) först när kortet finns i vyn
        .onAppear { DispatchQueue.main.async { focusPlay = true } }
    }

    private var edge: CGFloat {
        #if os(tvOS)
        return 80
        #else
        return 110
        #endif
    }
}

/// Knappens text i spelaren (svenskan är också nyckeln i Localizable.strings – visas med L())
enum SkipKind {
    static let recap = "Hoppa över sammanfattning"
    static let intro = "Hoppa över intro"
    static let next = "Nästa avsnitt"
    static let preroll = "Hoppa över"
}

// MARK: - Långsam start, fel under uppspelningen och stopp från servern

// (sist i filen så att radhänvisningarna i test/contracts/apps.json står kvar; private-medlemmar nås från samma fil)
extension PlayerController {
    /// Strömmen förbereds. Efter 4 s utan bild visas en förklaring – omkodning med grafikkort kan ta ~10 s till
    /// första segmentet, och då ska ingen tro att appen hängt sig och starta om (en ny start = en ny session).
    fileprivate func beginPreparing(gen: Int) {
        preparing = true
        slowStart = false
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard let self, self.generation == gen, self.preparing, !self.closed else { return }
            self.slowStart = true
        }
    }

    fileprivate func playStateChanged(_ playing: Bool) {
        guard playing, !closed else { return }
        preparing = false
        slowStart = false
        // Bara själva filmen räknas – en trailer i bio-läget som spelar betyder inte att filmen har startat
        if prerollTitle == nil { playbackBegan = true; seekWatch?.markStarted() }
    }

    fileprivate func makeMainItem(_ url: URL) -> AVPlayerItem {
        let item = AVPlayerItem(asset: AVURLAsset(url: url))
        item.externalMetadata = mainMeta
        #if os(tvOS)
        item.navigationMarkerGroups = chapterMarkers(chapters)
        #endif
        return item
    }

    /// Bevakar filmens AVPlayerItem: misslyckas den hanteras det i mainFailed (annars blir det bara svart)
    fileprivate func watchMain(_ item: AVPlayerItem, gen: Int) {
        clearMainObservers()
        let oid = ObjectIdentifier(item)
        mainStatus = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            guard it.status == .failed else { return }
            let msg = it.error?.localizedDescription
            Task { @MainActor [weak self] in self?.mainFailed(oid, gen: gen, message: msg) }
        }
        mainFail = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] n in
            let msg = (n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
            Task { @MainActor [weak self] in self?.mainFailed(oid, gen: gen, message: msg) }
        }
    }

    fileprivate func clearMainObservers() {
        mainStatus?.invalidate()
        mainStatus = nil
        if let f = mainFail { NotificationCenter.default.removeObserver(f); mainFail = nil }
    }

    /// Filmen gick inte att spela. Under starten (innan bilden rört sig) provas samma ström-URL igen – samma pid,
    /// alltså samma session och samma ffmpeg på servern, ingen ny /playback. AVPlayer kan ge upp på ett segment som
    /// grafikkortet inte hunnit koda klart. Annars: stoppad av servern, eller ett fel med Försök igen.
    fileprivate func mainFailed(_ oid: ObjectIdentifier, gen: Int, message: String?) {
        guard !closed, gen == generation, let cur = player.currentItem, ObjectIdentifier(cur) == oid,
              stopNotice == nil, error == nil, !seekRestarting else { return }
        // Hemadressen svarar inte längre: samma ström-URL (samma session) via adressen som gäller nu, där filmen var
        if let url = mainURL {
            _ = model.homeFailed(url)
            if let fixed = model.homeRewrite(url) { switchStream(fixed, gen: gen); return }
        }
        if !playbackBegan, retries < 3, let url = mainURL {
            retries += 1
            let at = mainStart
            let item = makeMainItem(url)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self, self.generation == gen, !self.closed else { return }
                await self.startMain(item, at: at, gen: gen)
            }
            return
        }
        clearMainObservers()
        preparing = false
        slowStart = false
        let text = message ?? L("Strömmen kunde inte spelas.")
        // Har servern stoppat uppspelningen (Föräldraöversikten/skärmtiden) är det den förklaringen som gäller:
        // fråga med en framstegsrapport – svarar den stop ersätts felet av stoppmeddelandet
        if let id = currentId, serverSession {
            let t = player.currentTime().seconds
            let pos = t.isFinite && t > 1 ? t : mainStart
            model.reportProgress(id: id, position: pos, duration: duration) { [weak self] r in
                Task { @MainActor [weak self] in self?.stoppedByServer(r, id: id, gen: gen) }
            }
        }
        error = text
        canRetry = !isLocal
    }

    /// Hemadressen slutade gälla (annat nät): filmen byter till adressen som gäller nu, så att inget mer skickas till
    /// den gamla hemadressen. Samma ström-URL, alltså samma session på servern.
    fileprivate func homeLeft() {
        guard !closed, let url = mainURL, let fixed = model.homeRewrite(url) else { return }
        // Bio-läget: filmen har inte startat än – den väntande posten byggs om
        if mainItem != nil { mainURL = fixed; mainItem = makeMainItem(fixed); return }
        guard error == nil, stopNotice == nil, player.currentItem != nil else { return }
        switchStream(fixed, gen: generation)
    }

    /// Byter filmens adress och fortsätter där den var (pausad film förblir pausad)
    fileprivate func switchStream(_ url: URL, gen: Int) {
        let t = player.currentTime().seconds
        let at = t.isFinite && t > 1 ? t : mainStart
        // Startpositionen i spellistan (xs) följer med dit filmen är nu (samma session på servern)
        let moved = URL(string: SeekCore.withStart(url.absoluteString, at: at)) ?? url
        mainURL = moved
        let paused = playbackBegan && player.timeControlStatus == .paused
        let item = makeMainItem(moved)
        Task { [weak self] in
            guard let self, self.generation == gen, !self.closed else { return }
            await self.startMain(item, at: at, gen: gen)
            if paused, self.generation == gen { self.player.pause() }
        }
    }

    /// Nedladdad titel: räknar tiden medan bilden rör sig (högst 1 s per mätning – ett längre glapp är en paus)
    fileprivate func countLocal() {
        let now = ProcessInfo.processInfo.systemUptime
        if player.timeControlStatus == .playing, let b = localBeat { localPlayed += min(1, max(0, now - b)) }
        localBeat = now
    }

    /// Tiden som spelats sedan förra framsteget (nollställs)
    fileprivate func takeLocalPlayed() -> Double {
        let s = localPlayed
        localPlayed = 0
        return s
    }

    /// Framsteget för en nedladdad titel kom inte fram (inget nät): tiden räknas som skärmtid i appen, och är dagens
    /// tid slut eller klockslaget passerat stoppar spelaren med samma besked som servern ger. Tiden sparas också för att
    /// lämnas in när nätet kommer tillbaka (PendingScreenTime)
    fileprivate func playedOffline(_ secs: Double, play: String, id: Int, gen: Int) {
        let g = OfflineScreen.played(model, seconds: secs, play: play)
        if !closed, gen == generation, currentId == id { screenLeft = ScreenLeftCore.ofGate(g) }
        guard !g.allowed, !closed, gen == generation, currentId == id, isLocal, stopNotice == nil else { return }
        player.pause()
        stopReporting()
        stopNotice = OfflineScreen.message(g)
    }

    /// Servern svarade stop på framstegsanropet: sluta spela och visa varför
    fileprivate func stoppedByServer(_ r: ProgressReply, id: Int, gen: Int) {
        guard !closed, gen == generation, currentId == id, stopNotice == nil else { return }
        player.pause()
        stopReporting()
        clearMainObservers()
        preparing = false
        slowStart = false
        error = nil
        canRetry = false
        stopNotice = model.stopText(r)
    }

    /// Försök igen efter ett fel: en ny start där filmen var (ny /playback – användaren har själv valt det)
    func retry() {
        guard canRetry else { return }
        error = nil
        canRetry = false
        restart(audio: audio, subtitle: subtitle)
    }
}

// MARK: - Nästa avsnitt (NextCore) och skärmtiden kvar (ScreenLeftCore)

extension PlayerController {
    /// Förvärm nästa avsnitt (/playback?warm=1) med samma fråga som uppspelningen sedan skickar: från början, inget
    /// eget ljudspår eller undertext och bio-läget som servern avgör (playNext och skip spelar så). Start.warm frågar
    /// högst var 15:e sekund och hoppar över en nedladdad titel, så det går att anropa ofta.
    fileprivate func warmNext() {
        guard !closed, let next = item?.nextId else { return }
        Start.warm(model, id: next, start: 0, audio: nil, subtitle: nil)
    }

    /// Kortet "Nästa avsnitt om N s": räknar ner varje sekund (och håller förvärmningen vid liv), sedan nästa avsnitt
    fileprivate func showNext(_ seconds: Int) {
        nextTask?.cancel()
        warmNext()
        nextIn = NextCore.Countdown(seconds: seconds).left
        let gen = generation
        nextTask = Task { [weak self] in
            var cd = NextCore.Countdown(seconds: seconds)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, !self.closed, self.generation == gen, self.nextIn != nil else { return }
                let go = cd.tick()
                self.nextIn = cd.left
                if go { self.playNext(); return }
                self.warmNext()
            }
        }
    }

    /// Spela nu (eller nedräkningen är slut): nästa avsnitt från början, som skip() under eftertexterna
    func playNext() {
        nextTask?.cancel()
        nextTask = nil
        nextIn = nil
        guard !closed, let next = item?.nextId else { onFinished?(); return }
        load(itemId: next, at: 0, audio: nil, subtitle: nil)
    }

    /// Avbryt: kortet försvinner och spelaren står kvar i slutet (Stäng eller Menu på Apple TV går tillbaka)
    func cancelNext() {
        nextTask?.cancel()
        nextTask = nil
        nextIn = nil
    }

    /// screenTime i serverns svar på framstegen (saknas = ingen skärmtid för profilen)
    fileprivate func screenFromServer(_ st: ScreenStatus?, id: Int, gen: Int) {
        guard !closed, gen == generation, currentId == id else { return }
        screenLeft = ScreenLeftCore.ofServer(st)
    }
}

// MARK: - Spolning i en omkodning (SeekCore)

extension PlayerController {
    /// Omkodad ström: spellistans segment (för beslutet vid en spolning). Hämtas bredvid spelaren och påverkar inte
    /// starten; körningen på servern börjar vid segmentet med from.
    fileprivate func watchStream(_ url: URL, from: Double) {
        seekWatch = SeekCore.Watch()
        let sg = seekGen
        readyTask?.cancel()
        // Vad servern har klart frågas i förväg, var 4:e sekund medan strömmen spelar (askReady)
        readyTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(SeekCore.readyEvery * 1_000_000_000))
                guard !Task.isCancelled, let self, self.seekGen == sg, self.seekWatch != nil else { return }
                await self.askReady(sg: sg)
            }
        }
        guard let idx = URL(string: SeekCore.indexURL(url.absoluteString)) else { return }
        let req = URLRequest(url: idx, timeoutInterval: 10)
        Task { [weak self] in
            guard let pair = try? await URLSession.shared.data(for: req),
                  (pair.1 as? HTTPURLResponse)?.statusCode == 200,
                  let txt = String(data: pair.0, encoding: .utf8) else { return }
            guard let self, self.seekGen == sg, self.seekWatch != nil else { return }
            self.seekWatch?.setFrags(SeekCore.parseFrags(txt), from: from)
        }
    }

    /// Frågar servern vad den har klart för strömmen som spelas (GET /api/stream/:id/hls/ready med strömmens
    /// frågesträng: pid och mediatoken). Bara medan bilden rör sig och ingen omstart pågår; frågan startar aldrig
    /// ffmpeg. Svarar servern inte (äldre server, inget nät) gäller gissningen i SeekCore.readyGuess.
    fileprivate func askReady(sg: Int) async {
        guard let w = seekWatch, w.wantsReady, !seekRestarting, player.timeControlStatus == .playing,
              let cur = mainURL, let u = URL(string: SeekCore.readyURL(cur.absoluteString)) else { return }
        let seq = w.seq
        let sent = ProcessInfo.processInfo.systemUptime
        var req = URLRequest(url: u, timeoutInterval: 3)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let pair = try? await URLSession.shared.data(for: req),
              (pair.1 as? HTTPURLResponse)?.statusCode == 200,
              let r = try? JSONDecoder().decode(SeekCore.ReadyInfo.self, from: pair.0) else { return }
        guard !closed, seekGen == sg else { return }
        seekWatch?.setReady(r, sentAt: sent, seq: seq)
    }

    /// Slutet på bufferten där t ligger (t om inget är buffrat där)
    fileprivate func bufferedEnd(_ t: Double) -> Double {
        guard let ranges = player.currentItem?.loadedTimeRanges else { return t }
        for v in ranges {
            let r = v.timeRangeValue
            let a = r.start.seconds, b = CMTimeRangeGetEnd(r).seconds
            if a.isFinite, b.isFinite, t >= a - 0.1, t <= b { return b }
        }
        return t
    }

    /// Varje mätning (var 0,25 s och vid varje hopp i tiden): har användaren spolat utanför bufferten? Då startas
    /// strömmen om vid målet när inget nytt steg kommit på en stund: 0,6 s på Apple TV (fjärrkontrollens klick åt
    /// höger/vänster), 0,3 s på iPhone/iPad (reglaget som drar). Ett nytt steg flyttar målet; hamnar det där spelaren
    /// klarar sig själv behövs ingen omstart.
    fileprivate func observeSeek(_ t: Double) {
        let now = SeekCore.Sample(pos: t, buf: bufferedEnd(t), at: ProcessInfo.processInfo.systemUptime,
                                  playing: player.timeControlStatus == .playing, rate: Double(player.rate))
        guard let action = seekWatch?.observe(now) else { return }
        switch action {
        case .keep:
            break
        case .cancel:
            settleTask?.cancel()
            settleTask = nil
        case .restart:
            settleTask?.cancel()
            let gen = generation
            let wait = PlayerController.settle
            settleTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                guard !Task.isCancelled, let self, self.generation == gen, let to = self.seekWatch?.pending else { return }
                await self.seekRestart(to: to, gen: gen)
            }
        }
    }

    /// Väntan på nästa steg före en omstart (SeekCore.settle): bara Apple TV har fjärrkontrollens steg
    fileprivate static var settle: Double {
        #if os(tvOS)
        return SeekCore.settle(remote: true)
        #else
        return SeekCore.settle(remote: false)
        #endif
    }

    /// Spolning i en omkodning: strömmen startas om vid målet (/playback med start och prev). Servern ger korta
    /// segment där och stoppar den gamla strömmen. Samma ljudspår, undertext (ritas av appen), hastighet och paus som
    /// förut; adressen är den som gäller nu (hemadressen hemma, model.get/absolute).
    fileprivate func seekRestart(to t: Double, gen: Int) async {
        guard !closed, generation == gen, let id = currentId, let old = pb else { return }
        seekGen += 1
        let sg = seekGen
        seekWatch = nil
        readyTask?.cancel()
        readyTask = nil
        seekRestarting = true
        let play = player.timeControlStatus != .paused
        let rate = player.rate
        // Den gamla strömmen står still: den stoppas ändå på servern (prev), och dess fel visas inte (seekRestarting)
        player.pause()
        // Före första bilden i den nya strömmen gäller målet (restart() och nya försök i mainFailed)
        mainStart = t
        playbackBegan = false
        retries = 0
        var q = model.capabilities(audio: selectedAudio ?? audio, subtitle: subtitle) + model.comfortQuery()
        q.append(URLQueryItem(name: "start", value: String(Int(t))))
        if let pid = SeekCore.pidOf(old.url) { q.append(URLQueryItem(name: "prev", value: pid)) }
        do {
            let p: Playback = try await model.get("/api/items/\(id)/playback", q)
            guard !closed, generation == gen, seekGen == sg else { stopReplaced(id, p.url); return }
            guard let url = model.absolute(p.mode == "direct" ? p.url : SeekCore.withStart(p.url, at: t)) else { throw APIError(message: L("Ogiltig ström-URL")) }
            pb = p
            mainURL = url
            if let a = p.audio, !a.isEmpty { audioTracks = a }
            selectedAudio = p.audioSelected.flatMap { Int($0) } ?? selectedAudio
            let item = makeMainItem(url)
            seekRestarting = false
            if p.mode == "transcode" { watchStream(url, from: t) }
            await startMain(item, at: t, gen: gen, play: play)
            guard !closed, generation == gen, seekGen == sg else { return }
            if play, rate > 0, rate != 1 { player.rate = rate }
            // Pausad: ingen spelstart som markerar bilden – spelarens egna hopp är klara när startMain är klar
            if !play { seekWatch?.markStarted() }
        } catch {
            guard !closed, generation == gen, seekGen == sg, !isCancellation(error) else { return }
            seekRestarting = false
            preparing = false
            slowStart = false
            self.error = error.localizedDescription
            canRetry = true
        }
    }

    /// En ström som ersattes innan den användes stoppas (replaced=1: uppspelningen fortsätter, inget stopp räknas)
    fileprivate func stopReplaced(_ id: Int, _ url: String) {
        guard let pid = SeekCore.pidOf(url) else { return }
        Task { [model] in _ = try? await model.post("/api/stream/\(id)/stop?pid=\(pid)&replaced=1") }
    }
}
