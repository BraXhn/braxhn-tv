import SwiftUI
import AVFoundation
import MediaPlayer

// MARK: - Modeller (matchar /api/music)

struct MAlbum: Decodable, Identifiable, Hashable {
    let id: Int
    let title: String
    let year: Int?
    let cover: Bool
    let artist: String?
    let artistId: Int?
    let tracks: Int?
}

struct MTrack: Decodable, Identifiable, Hashable {
    let id: Int
    let title: String
    let track: Int?
    let duration: Double?
    let albumId: Int?
    let album: String?
    let cover: Bool
    let artist: String?
}

struct MAlbumDetail: Decodable {
    let id: Int
    let title: String
    let artist: String?
    let year: Int?
    let cover: Bool
    let trackList: [MTrack]
}

struct MHome: Decodable {
    let recentAlbums: [MAlbum]
    let recentlyPlayed: [MAlbum]
    let favorites: [MTrack]
}

struct PlayURL: Decodable { let url: String }

// MARK: - Spelare (bakgrundsljud, låsskärm, Kontrollcenter)

@MainActor
final class MusicPlayer: ObservableObject {
    static let shared = MusicPlayer()
    @Published private(set) var queue: [MTrack] = []
    @Published private(set) var index = 0
    @Published private(set) var playing = false
    @Published var position: Double = 0

    var current: MTrack? { queue.indices.contains(index) ? queue[index] : nil }
    private let player = AVPlayer()
    private weak var model: AppModel?
    private var endObserver: NSObjectProtocol?
    private var timeObserver: Any?

    private init() {
        player.allowsExternalPlayback = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] t in
            let s = t.seconds
            Task { @MainActor [weak self] in self?.position = s.isFinite ? s : 0 }
        }
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.resume() }; return .success }
        cc.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.toggle() }; return .success }
        cc.nextTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.next() }; return .success }
        cc.previousTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.previous() }; return .success }
    }

    func play(_ tracks: [MTrack], at i: Int, model: AppModel) {
        self.model = model
        queue = tracks
        Task { await load(i) }
    }

    private func load(_ i: Int) async {
        guard let model = model, queue.indices.contains(i) else { return }
        index = i
        let t = queue[i]
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        do {
            let p: PlayURL = try await model.get("/api/music/tracks/\(t.id)/play")
            // Lägg till vilka format enheten spelar själv
            guard let url = model.absolute(p.url + "&a=mp3,aac,flac,alac") else { return }
            let item = AVPlayerItem(url: url)
            if let e = endObserver { NotificationCenter.default.removeObserver(e) }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.next() }
            }
            player.replaceCurrentItem(with: item)
            player.play()
            playing = true
            updateNowPlaying()
            try? await model.post("/api/music/tracks/\(t.id)/played")
        } catch {
            playing = false
        }
    }

    func toggle() { playing ? pause() : resume() }
    func pause() { player.pause(); playing = false; updateNowPlaying() }
    func resume() { player.play(); playing = true; updateNowPlaying() }
    func next() { if index + 1 < queue.count { Task { await load(index + 1) } } else { pause() } }
    func previous() {
        if player.currentTime().seconds > 3 { player.seek(to: .zero) }
        else if index > 0 { Task { await load(index - 1) } }
    }
    func stop() { player.pause(); player.replaceCurrentItem(with: nil); queue = []; playing = false; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }

    private func updateNowPlaying() {
        guard let t = current else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyArtist: t.artist ?? "",
            MPMediaItemPropertyAlbumTitle: t.album ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0
        ]
        if let d = t.duration { info[MPMediaItemPropertyPlaybackDuration] = d }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // Omslag laddas i bakgrunden
        if let a = t.albumId, t.cover, let model = model, let tok = model.imageToken,
           let url = model.url("/api/music/cover/\(a)", [URLQueryItem(name: "t", value: tok)]) {
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
}

// MARK: - Vyer

func coverView(_ model: AppModel, albumId: Int?, has: Bool, size: CGFloat) -> some View {
    let url: URL? = {
        guard let a = albumId, has, let t = model.imageToken else { return nil }
        return model.url("/api/music/cover/\(a)", [URLQueryItem(name: "t", value: t)])
    }()
    return AsyncImage(url: url) { ph in
        if let img = ph.image { img.resizable().scaledToFill() }
        else { ZStack { LinearGradient(colors: [.purple.opacity(0.5), .black], startPoint: .topLeading, endPoint: .bottomTrailing); Image(systemName: "music.note").font(.title) } }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: 8))
}

struct MusicView: View {
    @EnvironmentObject var model: AppModel
    @State private var libs: [Library] = []
    @State private var home: MHome?
    @State private var albums: [MAlbum] = []
    @State private var error: String?

    private var size: CGFloat {
        #if os(tvOS)
        return 260
        #else
        return 150
        #endif
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let e = error { Text(e).foregroundStyle(.secondary) }
                if libs.isEmpty && error == nil { Text("Inget musikbibliotek ännu – lägg till ett under Administration i webben.").foregroundStyle(.secondary).padding() }
                if let h = home {
                    if !h.recentlyPlayed.isEmpty { albumRow("Spelat nyligen", h.recentlyPlayed) }
                    if !h.recentAlbums.isEmpty { albumRow("Nytt", h.recentAlbums) }
                    if !h.favorites.isEmpty {
                        HStack { Text("Favoriter").font(.title3.bold()); Spacer()
                            Button { MusicPlayer.shared.play(h.favorites.shuffled(), at: 0, model: model) } label: { Label("Blanda", systemImage: "shuffle") }.buttonStyle(.bordered)
                        }.padding(.horizontal)
                    }
                }
                if !albums.isEmpty {
                    Text("Alla album").font(.title3.bold()).padding(.horizontal)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: size), spacing: 16)], spacing: 20) {
                        ForEach(albums) { a in albumLink(a) }
                    }.padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("Musik")
        .navigationDestination(for: MAlbum.self) { AlbumView(album: $0) }
        .task { await load() }
    }

    private func albumRow(_ title: String, _ list: [MAlbum]) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.title3.bold()).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 16) { ForEach(list) { a in albumLink(a) } }.padding(.horizontal)
                #if os(tvOS)
                    .padding(.vertical, 30)
                #endif
            }
        }
    }

    private func albumLink(_ a: MAlbum) -> some View {
        NavigationLink(value: a) {
            VStack(alignment: .leading, spacing: 4) {
                coverView(model, albumId: a.id, has: a.cover, size: size)
                Text(a.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(a.artist ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.frame(width: size)
        }
        .cardButton()
    }

    private func load() async {
        do {
            await model.refreshImageToken()
            let l: [Library] = try await model.get("/api/libraries")
            libs = l.filter { $0.type == "music" }
            guard let m = libs.first else { return }
            async let h: MHome = model.get("/api/music/\(m.id)/home")
            async let a: [MAlbum] = model.get("/api/music/\(m.id)/albums", [URLQueryItem(name: "sort", value: "artist")])
            let (hh, aa) = try await (h, a)
            home = hh
            albums = aa
        } catch { self.error = error.localizedDescription }
    }
}

struct AlbumView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var mp = MusicPlayer.shared
    let album: MAlbum
    @State private var detail: MAlbumDetail?

    var body: some View {
        List {
            HStack(spacing: 16) {
                coverView(model, albumId: album.id, has: album.cover, size: 140)
                VStack(alignment: .leading, spacing: 6) {
                    Text(album.title).font(.title2.bold())
                    Text([album.artist, album.year.map(String.init)].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.secondary)
                    HStack {
                        Button { if let d = detail { mp.play(d.trackList, at: 0, model: model) } } label: { Label("Spela", systemImage: "play.fill") }.buttonStyle(.borderedProminent)
                        Button { if let d = detail { mp.play(d.trackList.shuffled(), at: 0, model: model) } } label: { Label("Blanda", systemImage: "shuffle") }.buttonStyle(.bordered)
                    }
                }
            }
            ForEach(Array((detail?.trackList ?? []).enumerated()), id: \.element.id) { i, t in
                Button { if let d = detail { mp.play(d.trackList, at: i, model: model) } } label: {
                    HStack {
                        Text(t.track.map(String.init) ?? "\(i + 1)").foregroundStyle(.secondary).frame(width: 28, alignment: .leading)
                        Text(t.title).foregroundStyle(mp.current?.id == t.id ? accent : .primary)
                        Spacer()
                        Text(formatTime(t.duration ?? 0)).foregroundStyle(.secondary).font(.caption)
                    }
                }
            }
        }
        .navigationTitle(album.title)
        .task { detail = try? await model.get("/api/music/albums/\(album.id)") }
    }
}

/// Minispelare som visas ovanför flikarna när musik spelas.
struct MiniPlayer: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var mp = MusicPlayer.shared
    var body: some View {
        if let t = mp.current {
            HStack(spacing: 12) {
                coverView(model, albumId: t.albumId, has: t.cover, size: 44)
                VStack(alignment: .leading) {
                    Text(t.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(t.artist ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { mp.previous() } label: { Image(systemName: "backward.fill") }
                Button { mp.toggle() } label: { Image(systemName: mp.playing ? "pause.fill" : "play.fill").font(.title2) }
                Button { mp.next() } label: { Image(systemName: "forward.fill") }
                Button { mp.stop() } label: { Image(systemName: "xmark") }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 10)
        }
    }
}
