import SwiftUI
import AVFoundation
import MediaPlayer

// MARK: - Modeller (matchar /api/audiobooks och /api/podcasts)

struct BookFile: Decodable, Hashable {
    let id: Int
    let idx: Int
    let offset: Double
    let duration: Double?
    let url: String?
}

struct Book: Decodable, Identifiable, Hashable {
    let id: Int
    let title: String
    let author: String?
    let narrator: String?
    let duration: Double?
    let cover: Bool
    let position: Double
    let finished: Bool
    let description: String?
    let speed: Double?
    let chapters: [Chapter]?
    let files: [BookFile]?
}

struct BookList: Decodable {
    let `continue`: [Book]
    let books: [Book]
}

struct Podcast: Decodable, Identifiable, Hashable {
    let id: Int
    let title: String?
    let author: String?
    let image: Bool
    let unplayed: Int?
    let description: String?
    let episodes: [Episode]?

    // Listan (/api/podcasts) skickar antalet avsnitt som ett tal, detaljvyn en lista –
    // avkoda listan bara när den finns så att hela poddlistan inte misslyckas
    enum CodingKeys: String, CodingKey { case id, title, author, image, unplayed, description, episodes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        image = (try? c.decodeIfPresent(Bool.self, forKey: .image)) ?? false
        unplayed = try? c.decodeIfPresent(Int.self, forKey: .unplayed)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        episodes = try? c.decodeIfPresent([Episode].self, forKey: .episodes)
    }
}

struct Episode: Decodable, Identifiable, Hashable {
    let id: Int
    let podcast: Int
    let podcastTitle: String?
    let title: String
    let description: String?
    let published: Double?
    let duration: Double?
    let position: Double
    let played: Bool
}

struct PodcastList: Decodable {
    let podcasts: [Podcast]
    let latest: [Episode]
}

// MARK: - Spelare för tal (ljudböcker och poddar)

/// Spelar ljudböcker (flera filer med gemensam tidslinje) och poddavsnitt. Sparar positionen regelbundet,
/// har hastighetsval och hopp ±15/30 s på låsskärmen, i Kontrollcenter och på AirPods.
@MainActor
final class SpokenPlayer: ObservableObject {
    static let shared = SpokenPlayer()

    enum Kind { case book, podcast }
    struct Track { let kind: Kind; let id: Int; let title: String; let subtitle: String; let artPath: String?; let duration: Double; var files: [BookFile]; let chapters: [Chapter] }

    @Published private(set) var track: Track?
    @Published private(set) var playing = false
    /// Publiceras bara när kapitlet byts – positionen i sig publiceras inte (annars ritas kapitellistan om varje sekund)
    @Published private(set) var chapterIndex: Int?
    private(set) var position: Double = 0
    @Published var speed: Float = Float(UserDefaults.standard.double(forKey: "speed") == 0 ? 1 : UserDefaults.standard.double(forKey: "speed")) {
        didSet { UserDefaults.standard.set(Double(speed), forKey: "speed"); if playing { player.rate = speed } }
    }

    private let player = AVPlayer()
    private weak var model: AppModel?
    private var fileIndex = 0
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var failObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var lastSave = Date.distantPast
    /// Ström-URL:erna har en mediatoken som gäller 24 h – förnyas efter 20 h
    private var urlsFetched = Date()
    private var refreshing = false
    private var retried = false
    /// Ökas när ett nytt spår startas eller spelaren stoppas
    private var trackGen = 0

    private init() {
        player.allowsExternalPlayback = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] t in
            let s = t.seconds
            Task { @MainActor [weak self] in self?.tick(s) }
        }
    }

    /// Hoppintervallen på låsskärmen följer lyssningsinställningarna
    func refreshSkipIntervals() {
        let cc = MPRemoteCommandCenter.shared()
        cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: ListenSettings.shared.skipBack)]
        cc.skipForwardCommand.preferredIntervals = [NSNumber(value: ListenSettings.shared.skipForward)]
    }

    /// Kommandon på låsskärmen – registreras när tal spelas (musikspelaren registrerar sina egna)
    private func installCommands() {
        let cc = MPRemoteCommandCenter.shared()
        refreshSkipIntervals()
        cc.skipBackwardCommand.removeTarget(nil)
        cc.skipForwardCommand.removeTarget(nil)
        cc.changePlaybackPositionCommand.removeTarget(nil)
        cc.skipBackwardCommand.addTarget { [weak self] _ in Task { @MainActor in self?.skip(-Double(ListenSettings.shared.skipBack)) }; return .success }
        cc.skipForwardCommand.addTarget { [weak self] _ in Task { @MainActor in self?.skip(Double(ListenSettings.shared.skipForward)) }; return .success }
        cc.changePlaybackPositionCommand.addTarget { [weak self] e in
            if let e = e as? MPChangePlaybackPositionCommandEvent { let t = e.positionTime; Task { @MainActor in self?.seek(t) } }
            return .success
        }
        Self.setSkipCommands(true)
    }

    /// Hopp ±15/30 s visas bara på låsskärmen när tal spelas (annars syns inte musikens nästa/föregående)
    static func setSkipCommands(_ on: Bool) {
        let cc = MPRemoteCommandCenter.shared()
        cc.skipBackwardCommand.isEnabled = on
        cc.skipForwardCommand.isEnabled = on
        cc.changePlaybackPositionCommand.isEnabled = on
    }

    func play(book id: Int, model: AppModel, from start: Double? = nil) async {
        self.model = model
        Task { await ListenSettings.shared.refresh(model) }
        do {
            let b: Book = try await model.get("/api/audiobooks/book/\(id)/play", [URLQueryItem(name: "a", value: "mp3,aac,flac,alac")])
            let t = Track(kind: .book, id: b.id, title: b.title, subtitle: b.author ?? "", artPath: b.cover ? "/api/audiobooks/cover/\(b.id)" : nil,
                          duration: b.duration ?? 0, files: b.files ?? [], chapters: b.chapters ?? [])
            if let s = b.speed, s > 0 { speed = Float(s) }
            begin(t, at: start ?? (b.finished ? 0 : b.position))
        } catch {}
    }

    func play(episode e: Episode, model: AppModel) async {
        self.model = model
        Task { await ListenSettings.shared.refresh(model) }
        guard let u: PlayURL = try? await model.get("/api/podcasts/episodes/\(e.id)/play") else { return }
        let t = Track(kind: .podcast, id: e.id, title: e.title, subtitle: e.podcastTitle ?? "", artPath: "/api/podcasts/\(e.podcast)/image",
                      duration: e.duration ?? 0, files: [BookFile(id: e.id, idx: 0, offset: 0, duration: e.duration, url: u.url)], chapters: [])
        begin(t, at: e.played ? 0 : e.position)
    }

    private func begin(_ t: Track, at start: Double) {
        save()
        AudioFocus.willPlay(.spoken)
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        installCommands()
        trackGen += 1
        track = t
        urlsFetched = Date()
        retried = false
        chapterIndex = nil
        fileIndex = -1
        seek(start)
        updateNowPlaying(artwork: true)
    }

    private func fileFor(_ t: Double) -> Int {
        guard let tr = track else { return 0 }
        return max(0, tr.files.lastIndex { $0.offset <= t } ?? 0)
    }

    private var urlsStale: Bool { Date().timeIntervalSince(urlsFetched) > 20 * 3600 }

    func seek(_ t: Double) {
        guard track != nil else { return }
        if urlsStale && !refreshing { refreshThenSeek(t); return }
        load(t)
    }

    private func load(_ t: Double) {
        guard let tr = track, !tr.files.isEmpty else { return }
        let target = max(0, min(t, tr.duration > 0 ? tr.duration - 0.5 : t))
        let i = fileFor(target)
        let local = target - tr.files[i].offset
        if i != fileIndex {
            fileIndex = i
            guard let path = tr.files[i].url, let url = model?.absolute(path) else { return }
            let item = AVPlayerItem(url: url)
            item.audioTimePitchAlgorithm = .timeDomain // naturlig röst vid högre hastighet
            observe(item)
            player.replaceCurrentItem(with: item)
        }
        position = target
        player.seek(to: CMTime(seconds: local, preferredTimescale: 600))
        startPlayback()
    }

    private func observe(_ item: AVPlayerItem) {
        let nc = NotificationCenter.default
        if let e = endObserver { nc.removeObserver(e) }
        if let f = failObserver { nc.removeObserver(f) }
        endObserver = nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.fileEnded() }
        }
        failObserver = nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] n in
            let failed = n.object as? AVPlayerItem
            Task { @MainActor [weak self] in self?.itemFailed(failed) }
        }
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            guard it.status == .failed else { return }
            Task { @MainActor [weak self] in self?.itemFailed(it) }
        }
    }

    /// Strömmen gick inte att spela (troligen utgången token) – hämta nya URL:er och försök en gång till
    private func itemFailed(_ item: AVPlayerItem?) {
        guard let item, item === player.currentItem, track != nil else { return }
        if retried || refreshing {
            if !refreshing { playing = false; updateNowPlaying() }
            return
        }
        retried = true
        refreshThenSeek(position)
    }

    /// Hämtar nya ström-URL:er och laddar om aktuell fil på önskad position
    private func refreshThenSeek(_ t: Double) {
        guard let tr = track, let model else { load(t); return }
        refreshing = true
        let gen = trackGen
        Task {
            var files: [BookFile]?
            switch tr.kind {
            case .book:
                let b: Book? = try? await model.get("/api/audiobooks/book/\(tr.id)/play", [URLQueryItem(name: "a", value: "mp3,aac,flac,alac")])
                files = b?.files
            case .podcast:
                let u: PlayURL? = try? await model.get("/api/podcasts/episodes/\(tr.id)/play")
                files = u.map { [BookFile(id: tr.id, idx: 0, offset: 0, duration: tr.duration > 0 ? tr.duration : nil, url: $0.url)] }
            }
            refreshing = false
            // Annat spår startat eller spelaren stoppad under tiden
            guard gen == trackGen, track != nil else { return }
            if let f = files, !f.isEmpty {
                track?.files = f
                urlsFetched = Date()
                fileIndex = -1 // tvinga ny AVPlayerItem med de nya URL:erna
            }
            load(t)
        }
    }

    func skip(_ d: Double) { seek(position + d) }
    func toggle() { playing ? pause() : resume() }
    func resume() {
        guard track != nil else { return }
        if urlsStale && !refreshing { refreshThenSeek(position); return }
        startPlayback()
    }
    private func startPlayback() {
        AudioFocus.willPlay(.spoken)
        Self.setSkipCommands(true)
        player.playImmediately(atRate: speed); playing = true; updateNowPlaying()
    }
    func pause() { player.pause(); playing = false; save(); updateNowPlaying() }

    /// Sovtimern: tona ner (0…1)
    func setFade(_ f: Float) { player.volume = f }

    /// Aktuell position direkt från spelaren (position uppdateras bara en gång per sekund)
    private var livePosition: Double {
        guard let tr = track, tr.files.indices.contains(fileIndex) else { return position }
        let s = player.currentTime().seconds
        return s.isFinite ? tr.files[fileIndex].offset + s : position
    }

    /// Sekunder (i verklig tid) kvar av kapitlet (ljudbok) eller avsnittet – för sovtimern
    func remainingInSection() -> Double? {
        guard let tr = track else { return nil }
        let p = livePosition
        var end = tr.duration
        if tr.chapters.count > 1, let c = tr.chapters.last(where: { $0.start <= p }) { end = end > 0 ? min(end, c.end) : c.end }
        if end <= 0, tr.files.indices.contains(fileIndex) {
            let d = player.currentItem?.duration.seconds ?? .nan
            if d.isFinite && d > 0 { end = tr.files[fileIndex].offset + d }
        }
        guard end > 0 else { return nil }
        return (end - p) / Double(max(speed, 0.1))
    }
    /// Pausar utan att ta över låsskärmen (när musik eller video startar)
    func yieldFocus() {
        guard playing else { return }
        player.pause()
        playing = false
        save()
    }
    func stop() {
        save()
        trackGen += 1
        player.pause()
        player.replaceCurrentItem(with: nil)
        statusObservation = nil
        track = nil
        chapterIndex = nil
        playing = false
        Self.setSkipCommands(false)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    var chapter: Chapter? {
        guard let i = chapterIndex, let ch = track?.chapters, ch.indices.contains(i) else { return nil }
        return ch[i]
    }

    private func fileEnded() {
        guard let tr = track else { return }
        retried = false
        if fileIndex + 1 < tr.files.count { seek(tr.files[fileIndex + 1].offset + 0.01) }
        else { position = tr.duration; save(final: true); playing = false; updateNowPlaying() }
    }

    private func tick(_ local: Double) {
        guard let tr = track, local.isFinite, tr.files.indices.contains(fileIndex) else { return }
        position = tr.files[fileIndex].offset + local
        let ci = tr.chapters.lastIndex { $0.start <= position }
        if ci != chapterIndex {
            chapterIndex = ci
            updateNowPlaying()
        }
        if playing, Date().timeIntervalSince(lastSave) > 15 { save() }
    }

    private func save(final: Bool = false) {
        guard let tr = track, let model else { return }
        lastSave = Date()
        let pos = final ? tr.duration : position
        guard final || pos > 5 else { return }
        let path = tr.kind == .book ? "/api/audiobooks/book/\(tr.id)/progress" : "/api/podcasts/episodes/\(tr.id)/progress"
        let body: [String: Any] = ["position": pos, "speed": Double(speed)]
        Task { _ = try? await model.post(path, body) }
    }

    private func updateNowPlaying(artwork: Bool = false) {
        guard let tr = track else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: chapter.map { "\(tr.title) – \($0.title)" } ?? tr.title,
            MPMediaItemPropertyArtist: tr.subtitle,
            MPMediaItemPropertyPlaybackDuration: tr.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? Double(speed) : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0
        ]
        if let old = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork], !artwork { info[MPMediaItemPropertyArtwork] = old }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        guard artwork, let p = tr.artPath, let model, let tok = model.imageToken, let url = model.url(p, [URLQueryItem(name: "t", value: tok)]) else { return }
        Task.detached {
            guard let res = try? await URLSession.shared.data(from: url), let img = UIImage(data: res.0) else { return }
            let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            await MainActor.run {
                var cur = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                cur[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = cur
            }
        }
    }
}

// MARK: - Vyer

func speedLabel(_ s: Float) -> String {
    var t = String(format: "%.2f", Double(s))
    while t.hasSuffix("0") { t.removeLast() }
    if t.hasSuffix(".") { t.removeLast() }
    return t.replacingOccurrences(of: ".", with: ",") + "×"
}

@MainActor
func artView(_ model: AppModel, path: String?, size: CGFloat, symbol: String) -> some View {
    let url: URL? = {
        guard let p = path, let t = model.imageToken else { return nil }
        return model.url(p, [URLQueryItem(name: "t", value: t)])
    }()
    return AsyncImage(url: url) { ph in
        if let img = ph.image { img.resizable().scaledToFill() }
        else { ZStack { LinearGradient(colors: [.orange.opacity(0.45), .black], startPoint: .topLeading, endPoint: .bottomTrailing); Image(systemName: symbol).font(.title) } }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: 8))
}

struct ListenView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0
    @State private var bookLib: Library?
    @State private var books: BookList?
    @State private var pods: PodcastList?
    @State private var error: String?

    private var size: CGFloat {
        #if os(tvOS)
        return 240
        #else
        return 140
        #endif
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Picker("", selection: $tab) {
                    Text("Ljudböcker").tag(0)
                    Text("Poddar").tag(1)
                }
                .pickerStyle(.segmented).padding(.horizontal)
                if let e = error { Text(e).foregroundStyle(.secondary).padding(.horizontal) }
                if tab == 0 { booksSection } else { podsSection }
            }
            .padding(.vertical)
        }
        .navigationTitle("Lyssna")
        .navigationDestination(for: Book.self) { BookView(bookId: $0.id) }
        .navigationDestination(for: Podcast.self) { PodcastView(podcastId: $0.id) }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private var booksSection: some View {
        if bookLib == nil { Text("Inget ljudboksbibliotek ännu – lägg till ett under Administration i webben.").foregroundStyle(.secondary).padding(.horizontal) }
        if let b = books {
            if !b.continue.isEmpty {
                Text("Fortsätt lyssna").font(.title3.bold()).padding(.horizontal)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 16) { ForEach(b.continue) { bookLink($0) } }.padding(.horizontal)
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: size), spacing: 16)], spacing: 20) {
                ForEach(b.books) { bookLink($0) }
            }.padding(.horizontal)
        }
    }

    @ViewBuilder private var podsSection: some View {
        if let p = pods {
            if p.podcasts.isEmpty { Text("Inga poddar ännu – lägg till under Poddar i webben.").foregroundStyle(.secondary).padding(.horizontal) }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 16) {
                    ForEach(p.podcasts) { pod in
                        NavigationLink(value: pod) {
                            VStack(alignment: .leading, spacing: 4) {
                                artView(model, path: pod.image ? "/api/podcasts/\(pod.id)/image" : nil, size: size, symbol: "mic")
                                Text(pod.title ?? "").font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text((pod.unplayed ?? 0) > 0 ? "\(pod.unplayed ?? 0) nya" : (pod.author ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }.frame(width: size)
                        }
                        .cardButton()
                    }
                }.padding(.horizontal)
            }
            if !p.latest.isEmpty {
                Text("Senaste avsnitten").font(.title3.bold()).padding(.horizontal)
                VStack(spacing: 0) { ForEach(p.latest) { EpisodeRow(episode: $0) } }.padding(.horizontal)
            }
        }
    }

    private func bookLink(_ b: Book) -> some View {
        NavigationLink(value: b) {
            VStack(alignment: .leading, spacing: 4) {
                artView(model, path: b.cover ? "/api/audiobooks/cover/\(b.id)" : nil, size: size, symbol: "book")
                if let d = b.duration, d > 0, b.position > 0 { ProgressView(value: min(1, b.position / d)).tint(accent) }
                Text(b.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(b.author ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.frame(width: size)
        }
        .cardButton()
    }

    private func load() async {
        do {
            await model.refreshImageToken()
            let l: [Library] = try await model.get("/api/libraries")
            bookLib = l.first { $0.type == "audiobook" }
            if let bl = bookLib { books = try await model.get("/api/audiobooks/\(bl.id)", [URLQueryItem(name: "sort", value: "recent")]) }
            pods = try await model.get("/api/podcasts")
        } catch { self.error = error.localizedDescription }
    }
}

struct EpisodeRow: View {
    @EnvironmentObject var model: AppModel
    let episode: Episode
    var body: some View {
        Button { Task { await SpokenPlayer.shared.play(episode: episode, model: model) } } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(episode.title).font(.subheadline.weight(.semibold)).lineLimit(2).foregroundStyle(episode.played ? .secondary : .primary)
                    Text([episode.podcastTitle, episode.duration.map { formatTime($0) }, episode.played ? "Lyssnad" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "play.circle.fill").font(.title2).foregroundStyle(accent)
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
}

struct BookView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var sp = SpokenPlayer.shared
    let bookId: Int
    @State private var book: Book?

    var body: some View {
        List {
            if let b = book {
                HStack(alignment: .top, spacing: 16) {
                    artView(model, path: b.cover ? "/api/audiobooks/cover/\(b.id)" : nil, size: 140, symbol: "book")
                    VStack(alignment: .leading, spacing: 6) {
                        Text(b.title).font(.title2.bold())
                        Text(b.author ?? "").foregroundStyle(.secondary)
                        if let n = b.narrator { Text("Uppläsare: \(n)").font(.caption).foregroundStyle(.secondary) }
                        if let d = b.duration { Text(b.position > 30 ? "\(formatTime(d - b.position)) kvar" : formatTime(d)).font(.caption).foregroundStyle(.secondary) }
                        Button { Task { await sp.play(book: b.id, model: model) } } label: {
                            Label(b.position > 30 ? "Fortsätt" : "Lyssna", systemImage: "play.fill")
                        }.buttonStyle(.borderedProminent)
                    }
                }
                if let d = b.description, !d.isEmpty { Text(d).font(.callout).foregroundStyle(.secondary) }
                Section("Kapitel") {
                    ForEach(b.chapters ?? []) { c in
                        Button {
                            if sp.track?.kind == .book && sp.track?.id == b.id { sp.seek(c.start + 0.01) }
                            else { Task { await sp.play(book: b.id, model: model, from: c.start + 0.01) } }
                        } label: {
                            HStack { Text(c.title).foregroundStyle(sp.chapter == c && sp.track?.id == b.id ? accent : .primary); Spacer(); Text(formatTime(c.end - c.start)).foregroundStyle(.secondary).font(.caption) }
                        }
                    }
                }
            }
        }
        .navigationTitle(book?.title ?? "")
        .task { book = try? await model.get("/api/audiobooks/book/\(bookId)") }
    }
}

struct PodcastView: View {
    @EnvironmentObject var model: AppModel
    let podcastId: Int
    @State private var pod: Podcast?
    var body: some View {
        List {
            if let p = pod {
                HStack(alignment: .top, spacing: 16) {
                    artView(model, path: p.image ? "/api/podcasts/\(p.id)/image" : nil, size: 120, symbol: "mic")
                    VStack(alignment: .leading, spacing: 6) {
                        Text(p.title ?? "").font(.title3.bold())
                        Text(p.author ?? "").foregroundStyle(.secondary)
                    }
                }
                ForEach((p.episodes ?? []).map { Episode(id: $0.id, podcast: $0.podcast, podcastTitle: p.title, title: $0.title, description: $0.description,
                                                         published: $0.published, duration: $0.duration, position: $0.position, played: $0.played) }) { EpisodeRow(episode: $0) }
            }
        }
        .navigationTitle(pod?.title ?? "")
        .task { pod = try? await model.get("/api/podcasts/\(podcastId)") }
    }
}

/// Minispelare för tal (visas ovanför flikarna, under musikens minispelare)
struct SpokenMiniPlayer: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var sp = SpokenPlayer.shared
    @ObservedObject private var ls = ListenSettings.shared
    var body: some View {
        if let t = sp.track {
            HStack(spacing: 12) {
                artView(model, path: t.artPath, size: 44, symbol: t.kind == .book ? "book" : "mic")
                VStack(alignment: .leading) {
                    Text(t.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(sp.chapter?.title ?? t.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { sp.skip(-Double(ls.skipBack)) } label: { Image(systemName: "gobackward.\(ls.skipBack)") }
                Button { sp.toggle() } label: { Image(systemName: sp.playing ? "pause.fill" : "play.fill").font(.title2) }
                Button { sp.skip(Double(ls.skipForward)) } label: { Image(systemName: "goforward.\(ls.skipForward)") }
                // Hastighet: tryck för att stega 1× → 1,25× → 1,5× → 1,75× → 2× → 0,75×
                Button {
                    let steps: [Float] = [0.75, 1, 1.25, 1.5, 1.75, 2]
                    let i = steps.firstIndex { $0 >= sp.speed - 0.01 } ?? 0
                    sp.speed = steps[(i + 1) % steps.count]
                } label: { Text(speedLabel(sp.speed)).font(.caption.bold()).frame(minWidth: 40) }
                Button { SleepTimer.shared.cycle() } label: { SleepLabel() }
                Button { sp.stop() } label: { Image(systemName: "xmark") }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 10)
        }
    }
}
