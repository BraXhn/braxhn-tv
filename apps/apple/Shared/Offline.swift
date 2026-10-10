import SwiftUI

/// Offline-nedladdningar (iPhone/iPad). Servern skapar en mobilanpassad MP4 som laddas ner till appen.
struct OfflineStatus: Decodable {
    let status: String
    let progress: Int?
    let url: String?
    let size: Int?
    let error: String?
}

struct DownloadRecord: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let subtitle: String
    let duration: Double?
    let file: String
    let size: Int64
}

@MainActor
final class Downloads: ObservableObject {
    static let shared = Downloads()
    @Published private(set) var records: [DownloadRecord] = []
    @Published private(set) var active: [Int: Double] = [:]   // itemId → 0…1
    @Published var lastError: String?

    private let dir: URL = {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private var indexURL: URL { dir.appendingPathComponent("index.json") }

    private init() {
        if let d = try? Data(contentsOf: indexURL), let r = try? JSONDecoder().decode([DownloadRecord].self, from: d) {
            records = r.filter { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0.file).path) }
        }
    }
    private func save() { if let d = try? JSONEncoder().encode(records) { try? d.write(to: indexURL) } }

    func localURL(for id: Int) -> URL? {
        guard let r = records.first(where: { $0.id == id }) else { return nil }
        let u = dir.appendingPathComponent(r.file)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
    func isDownloaded(_ id: Int) -> Bool { localURL(for: id) != nil }

    func download(_ item: MediaItem, quality: String, model: AppModel) {
        guard active[item.id] == nil, !isDownloaded(item.id) else { return }
        active[item.id] = 0
        Task {
            do {
                // 1. Be servern förbereda filen
                _ = try await model.post("/api/items/\(item.id)/offline", ["q": quality])
                var st: OfflineStatus
                repeat {
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                    st = try await model.get("/api/items/\(item.id)/offline", [URLQueryItem(name: "q", value: quality)])
                    if st.status == "error" { throw APIError(message: st.error ?? "Servern kunde inte skapa filen") }
                    active[item.id] = Double(st.progress ?? 0) / 200 // förberedelse = första halvan
                } while st.status != "ready"
                guard let rel = st.url, let url = model.absolute(rel) else { throw APIError(message: "Ingen nedladdningslänk") }
                // 2. Ladda ner
                let (tmp, resp) = try await URLSession.shared.download(from: url, delegate: ProgressDelegate { [weak self] p in
                    Task { @MainActor in self?.active[item.id] = 0.5 + p / 2 }
                })
                guard (resp as? HTTPURLResponse)?.statusCode ?? 0 < 300 else { throw APIError(message: "Nedladdningen misslyckades") }
                let name = "\(item.id).mp4"
                let dest = dir.appendingPathComponent(name)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int64) ?? 0
                records.removeAll { $0.id == item.id }
                records.append(DownloadRecord(id: item.id, title: item.isEpisode ? "\(item.showTitle ?? "") – \(item.title)" : item.title,
                                              subtitle: item.isEpisode ? item.sxe : (item.year.map(String.init) ?? ""), duration: item.duration, file: name, size: size))
                save()
            } catch {
                lastError = error.localizedDescription
            }
            active[item.id] = nil
        }
    }

    func remove(_ id: Int) {
        if let u = localURL(for: id) { try? FileManager.default.removeItem(at: u) }
        records.removeAll { $0.id == id }
        save()
    }
}

final class ProgressDelegate: NSObject, URLSessionTaskDelegate {
    let onProgress: (Double) -> Void
    private var observation: NSKeyValueObservation?
    init(_ onProgress: @escaping (Double) -> Void) { self.onProgress = onProgress }
    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        observation = task.progress.observe(\.fractionCompleted) { [onProgress] p, _ in onProgress(p.fractionCompleted) }
    }
}

struct DownloadsView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var dl = Downloads.shared
    @State private var play: PlayRequest?
    var body: some View {
        List {
            if dl.records.isEmpty { Text("Inget nedladdat. Öppna en film eller ett avsnitt och välj Ladda ner.").foregroundStyle(.secondary) }
            ForEach(dl.records) { r in
                Button { play = PlayRequest(itemId: r.id, start: 0, audio: nil, subtitle: nil) } label: {
                    VStack(alignment: .leading) {
                        Text(r.title).font(.headline)
                        Text("\(r.subtitle) · \(ByteCountFormatter.string(fromByteCount: r.size, countStyle: .file))").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { idx in for i in idx { dl.remove(dl.records[i].id) } }
        }
        .navigationTitle("Nedladdat")
        .fullScreenCover(item: $play) { PlayerScreen(request: $0).environmentObject(model) }
    }
}
