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

/// Nedladdningar sparas i Application Support (inte Dokument) och undantas från iCloud-säkerhetskopian.
private let downloadsDirectory: URL = {
    let fm = FileManager.default
    var d = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
    try? fm.createDirectory(at: d, withIntermediateDirectories: true)
    var v = URLResourceValues()
    v.isExcludedFromBackup = true
    try? d.setResourceValues(v)
    return d
}()

@MainActor
final class Downloads: ObservableObject {
    static let shared = Downloads()
    @Published private(set) var records: [DownloadRecord] = [] {
        didSet { downloadedIds = Set(records.map { $0.id }) }
    }
    /// Cache så att vyer inte behöver kolla disken vid varje omritning
    @Published private(set) var downloadedIds: Set<Int> = []
    @Published private(set) var active: [Int: Double] = [:]   // itemId → 0…1
    /// Avbrutna nedladdningar som kan återupptas (itemId → titel)
    @Published private(set) var resumable: [Int: String] = [:]
    @Published var lastError: String?

    private let dir = downloadsDirectory
    private var indexURL: URL { dir.appendingPathComponent("index.json") }
    private var pendingURL: URL { dir.appendingPathComponent("pending.json") }
    /// Metadata för nedladdningar som pågår (behövs när filen blir klar, även efter omstart av appen)
    private var pending: [Int: DownloadRecord] = [:]
    private var resumeData: [Int: Data] = [:]

    /// Bakgrundssession: nedladdningen fortsätter även när appen ligger i bakgrunden
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.background(withIdentifier: "net.braxhn.tv.downloads")
        c.isDiscretionary = false
        #if os(iOS)
        c.sessionSendsLaunchEvents = true
        #endif
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return URLSession(configuration: c, delegate: DownloadDelegate(), delegateQueue: q)
    }()

    private init() {
        migrateFromDocuments()
        if let d = try? Data(contentsOf: indexURL), let r = try? JSONDecoder().decode([DownloadRecord].self, from: d) {
            records = r.filter { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0.file).path) }
        }
        if let d = try? Data(contentsOf: pendingURL), let p = try? JSONDecoder().decode([DownloadRecord].self, from: d) {
            pending = Dictionary(p.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
        // Återanslut till bakgrundssessionen och visa nedladdningar som fortfarande pågår
        session.getAllTasks { [weak self] tasks in
            let ids = tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap { Int($0.taskDescription ?? "") }
            Task { @MainActor [weak self] in
                guard let self else { return }
                for id in ids where self.active[id] == nil { self.active[id] = 0.5 }
            }
        }
    }

    /// Äldre versioner sparade i Dokument/Downloads – flytta dit filerna hör hemma nu
    private func migrateFromDocuments() {
        let fm = FileManager.default
        let old = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        guard let files = try? fm.contentsOfDirectory(at: old, includingPropertiesForKeys: nil) else { return }
        for f in files {
            let dest = dir.appendingPathComponent(f.lastPathComponent)
            if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: f) } else { try? fm.moveItem(at: f, to: dest) }
        }
        if (try? fm.contentsOfDirectory(atPath: old.path))?.isEmpty ?? false { try? fm.removeItem(at: old) }
    }

    private func save() { if let d = try? JSONEncoder().encode(records) { try? d.write(to: indexURL) } }
    private func savePending() { if let d = try? JSONEncoder().encode(Array(pending.values)) { try? d.write(to: pendingURL) } }

    func localURL(for id: Int) -> URL? {
        guard downloadedIds.contains(id), let r = records.first(where: { $0.id == id }) else { return nil }
        let u = dir.appendingPathComponent(r.file)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
    func isDownloaded(_ id: Int) -> Bool { downloadedIds.contains(id) }

    func download(_ item: MediaItem, quality: String, model: AppModel) {
        guard active[item.id] == nil, !isDownloaded(item.id) else { return }
        active[item.id] = 0
        lastError = nil
        resumable[item.id] = nil
        resumeData[item.id] = nil
        pending[item.id] = DownloadRecord(id: item.id, title: item.isEpisode ? "\(item.showTitle ?? "") – \(item.title)" : item.title,
                                          subtitle: item.isEpisode ? item.sxe : (item.year.map(String.init) ?? ""),
                                          duration: item.duration, file: "\(item.id).mp4", size: 0)
        savePending()
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
                // 2. Ladda ner i bakgrundssessionen (resultatet kommer via DownloadDelegate)
                let task = session.downloadTask(with: url)
                task.taskDescription = String(item.id)
                task.resume()
            } catch {
                lastError = error.localizedDescription
                active[item.id] = nil
                pending[item.id] = nil
                savePending()
            }
        }
    }

    /// Återupptar en avbruten nedladdning där den slutade
    func retry(_ id: Int) {
        guard let d = resumeData[id] else { return }
        resumeData[id] = nil
        resumable[id] = nil
        lastError = nil
        active[id] = 0.5
        let task = session.downloadTask(withResumeData: d)
        task.taskDescription = String(id)
        task.resume()
    }

    func discardResumable(_ id: Int) {
        resumeData[id] = nil
        resumable[id] = nil
        pending[id] = nil
        savePending()
    }

    // MARK: Anrop från DownloadDelegate

    fileprivate func progress(_ id: Int, _ p: Double) {
        let v = 0.5 + min(1, max(0, p)) / 2
        // Publicera bara i steg om 1 % – annars ritas vyerna om för varje mottagen bit
        if let old = active[id], abs(v - old) < 0.01 { return }
        active[id] = v
    }

    fileprivate func finished(_ id: Int, file: String, size: Int64) {
        let p = pending[id]
        records.removeAll { $0.id == id }
        records.append(DownloadRecord(id: id, title: p?.title ?? "Nedladdning \(id)", subtitle: p?.subtitle ?? "",
                                      duration: p?.duration, file: file, size: size))
        save()
        active[id] = nil
        pending[id] = nil
        savePending()
    }

    fileprivate func failed(_ id: Int, message: String?, resumeData data: Data?) {
        active[id] = nil
        if let m = message { lastError = m }
        if let d = data {
            resumeData[id] = d
            resumable[id] = pending[id]?.title ?? "Nedladdning \(id)"
        } else {
            pending[id] = nil
            savePending()
        }
    }

    func remove(_ id: Int) {
        if let u = localURL(for: id) { try? FileManager.default.removeItem(at: u) }
        records.removeAll { $0.id == id }
        save()
    }
}

/// Tar emot händelser från bakgrundssessionen (körs på en seriell kö).
/// Systemets klarsignal för bakgrundssessionen (anropas när alla händelser har levererats)
final class BackgroundDownloadEvents {
    static let shared = BackgroundDownloadEvents()
    private let lock = NSLock()
    private var handler: (() -> Void)?
    func set(_ h: @escaping () -> Void) { lock.lock(); handler = h; lock.unlock() }
    func take() -> (() -> Void)? { lock.lock(); defer { lock.unlock() }; let h = handler; handler = nil; return h }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private var lastSent: [Int: Double] = [:]

    #if os(iOS)
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // Köas efter finished()/failed() på huvudaktören, så att filen hunnit registreras
        Task { @MainActor in BackgroundDownloadEvents.shared.take()?() }
    }
    #endif

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0, let id = Int(downloadTask.taskDescription ?? "") else { return }
        let p = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        // Skicka till huvudtråden högst var 1 %
        if let old = lastSent[downloadTask.taskIdentifier], p - old < 0.01, p < 1 { return }
        lastSent[downloadTask.taskIdentifier] = p
        Task { @MainActor in Downloads.shared.progress(id, p) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lastSent[downloadTask.taskIdentifier] = nil
        guard let id = Int(downloadTask.taskDescription ?? "") else { return }
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            Task { @MainActor in Downloads.shared.failed(id, message: "Nedladdningen misslyckades (\(code))", resumeData: nil) }
            return
        }
        // Filen måste flyttas innan metoden returnerar – annars tas den bort av systemet
        let name = "\(id).mp4"
        let dest = downloadsDirectory.appendingPathComponent(name)
        let fm = FileManager.default
        try? fm.removeItem(at: dest)
        do {
            try fm.moveItem(at: location, to: dest)
        } catch {
            let msg = error.localizedDescription
            Task { @MainActor in Downloads.shared.failed(id, message: msg, resumeData: nil) }
            return
        }
        let size = ((try? fm.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
        Task { @MainActor in Downloads.shared.finished(id, file: name, size: size) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lastSent[task.taskIdentifier] = nil
        guard let error, let id = Int(task.taskDescription ?? "") else { return }
        let ns = error as NSError
        let data = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        let msg: String? = (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled && data == nil) ? nil : error.localizedDescription
        Task { @MainActor in Downloads.shared.failed(id, message: msg, resumeData: data) }
    }
}

struct DownloadsView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var dl = Downloads.shared
    @State private var play: PlayRequest?
    var body: some View {
        List {
            if let e = dl.lastError {
                Section {
                    HStack {
                        Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Spacer()
                        Button { dl.lastError = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                    }
                }
            }
            if !dl.resumable.isEmpty {
                Section("Avbrutna") {
                    ForEach(dl.resumable.keys.sorted(), id: \.self) { id in
                        HStack {
                            Text(dl.resumable[id] ?? "").lineLimit(1)
                            Spacer()
                            Button("Fortsätt") { dl.retry(id) }.buttonStyle(.bordered)
                            Button(role: .destructive) { dl.discardResumable(id) } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                        }
                    }
                }
            }
            if !dl.active.isEmpty {
                Section("Pågår") {
                    ForEach(dl.active.keys.sorted(), id: \.self) { id in
                        let p = dl.active[id] ?? 0
                        HStack { Text(p < 0.5 ? "Förbereder…" : "Laddar ner…").font(.caption); ProgressView(value: p) }
                    }
                }
            }
            if dl.records.isEmpty && dl.active.isEmpty { Text("Inget nedladdat. Öppna en film eller ett avsnitt och välj Ladda ner.").foregroundStyle(.secondary) }
            ForEach(dl.records) { r in
                Button { play = PlayRequest(itemId: r.id, start: 0, audio: nil, subtitle: nil) } label: {
                    VStack(alignment: .leading) {
                        Text(r.title).font(.headline)
                        Text("\(r.subtitle) · \(ByteCountFormatter.string(fromByteCount: r.size, countStyle: .file))").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { idx in
                // Översätt index till id:n först – listan ändras när vi tar bort
                let ids = idx.compactMap { dl.records.indices.contains($0) ? dl.records[$0].id : nil }
                for id in ids { dl.remove(id) }
            }
        }
        .navigationTitle("Nedladdat")
        .fullScreenCover(item: $play) { PlayerScreen(request: $0).environmentObject(model) }
    }
}
