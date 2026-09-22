import Foundation
import Observation

/// Локальное состояние записей: сегменты на диске и очередь загрузки.
/// Хранится в JSON в Application Support; доступ через actor, UI получает снимки.
struct LocalSegment: Codable, Hashable, Identifiable {
    var id: String { "\(meetingId)/\(seq)" }
    let meetingId: String
    let seq: Int
    let fileName: String
    var durationSec: Double
    var sizeBytes: Int
    var uploadState: UploadState = .pending
    var attempts: Int = 0
    var lastError: String?

    enum UploadState: String, Codable { case pending, uploading, uploaded, failed }
}

struct LocalMeeting: Codable, Hashable, Identifiable {
    let id: String // id встречи на сервере
    var title: String
    var templateId: String
    var templateTitle: String
    var templateEmoji: String
    /// Код шаблона; "unclassified" — тип встречи ещё не выбран
    var templateCode: String?
    var startedAt: Date
    var endedAt: Date?
    var phase: Phase = .recording
    var markers: [Marker] = []
    var segments: [LocalSegment] = []
    var keepAudio: Bool = false
    var finalizeError: String?

    enum Phase: String, Codable {
        case recording, stopped, finalizing, finalized
        var title: String {
            switch self {
            case .recording: return "Идёт запись"
            case .stopped: return "Ожидает отправки"
            case .finalizing: return "Отправляется"
            case .finalized: return "Отправлено"
            }
        }
    }
    /// Есть ли ещё аудиофайлы на устройстве
    var hasAudio: Bool = true

    var uploadedCount: Int { segments.filter { $0.uploadState == .uploaded }.count }
    var allUploaded: Bool { !segments.isEmpty && segments.allSatisfy { $0.uploadState == .uploaded } }
    var recordedSeconds: Double { segments.reduce(0) { $0 + $1.durationSec } }
}

actor LocalStore {
    static let shared = LocalStore()

    private var meetings: [String: LocalMeeting] = [:]
    private let fileURL: URL
    private let recordingsDir: URL

    init() {
        let support = URL.applicationSupportDirectory
        fileURL = support.appending(path: "local-meetings.json")
        recordingsDir = support.appending(path: "Recordings", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: recordingsDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: fileURL), let decoded = try? JSONDecoder().decode([String: LocalMeeting].self, from: data) {
            meetings = decoded
        }
    }

    func directory(for meetingId: String) -> URL {
        let dir = recordingsDir.appending(path: meetingId, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return dir
    }

    func fileURL(for segment: LocalSegment) -> URL { directory(for: segment.meetingId).appending(path: segment.fileName) }

    /// Выполняет действие с файлом сегмента, пока тот гарантированно существует. Все удаления файлов идут через этот же
    /// actor, поэтому между проверкой и действием файл исчезнуть не может (нужно фоновой URLSession: uploadTask(fromFile:)
    /// на отсутствующем файле бросает необрабатываемое исключение).
    func withSegmentFile<T>(_ segment: LocalSegment, _ body: (URL) -> T) -> T? {
        guard let m = meetings[segment.meetingId], m.hasAudio, m.segments.contains(where: { $0.seq == segment.seq }) else { return nil }
        let url = fileURL(for: segment)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return body(url)
    }

    func all() -> [LocalMeeting] { meetings.values.sorted { $0.startedAt > $1.startedAt } }
    func meeting(_ id: String) -> LocalMeeting? { meetings[id] }

    func upsert(_ m: LocalMeeting) {
        meetings[m.id] = m
        persist()
    }

    func update(_ id: String, _ mutate: (inout LocalMeeting) -> Void) -> LocalMeeting? {
        guard var m = meetings[id] else { return nil }
        mutate(&m)
        meetings[id] = m
        persist()
        return m
    }

    func updateSegment(meetingId: String, seq: Int, _ mutate: (inout LocalSegment) -> Void) {
        guard var m = meetings[meetingId], let idx = m.segments.firstIndex(where: { $0.seq == seq }) else { return }
        mutate(&m.segments[idx])
        meetings[meetingId] = m
        persist()
    }

    func pendingSegments() -> [LocalSegment] {
        meetings.values.flatMap { $0.segments }.filter { $0.uploadState == .pending || $0.uploadState == .failed }
    }

    /// Удаляет аудио-файлы встречи (после успешной обработки или по настройке); запись остаётся с пометкой hasAudio=false
    func deleteAudio(meetingId: String) {
        let dir = recordingsDir.appending(path: meetingId)
        try? FileManager.default.removeItem(at: dir)
        if var m = meetings[meetingId] { m.hasAudio = false; meetings[meetingId] = m; persist() }
    }

    /// Записи, у которых аудио ещё на устройстве или отправка не завершена (для экрана настроек)
    func withAudioOrPending() -> [LocalMeeting] {
        all().filter { $0.hasAudio || $0.phase == .stopped || $0.phase == .finalizing }
    }

    /// Удаляет аудио записей, отправленных более N дней назад (политика «Хранить 7 дней»)
    func purgeOlderThan(days: Int) {
        let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
        for m in meetings.values where m.phase == .finalized && (m.endedAt ?? m.startedAt) < cutoff && m.hasAudio {
            deleteAudio(meetingId: m.id)
        }
    }

    func remove(_ id: String) {
        meetings.removeValue(forKey: id)
        deleteAudio(meetingId: id)
        persist()
    }

    /// Удаление аккаунта: стереть все локальные записи и аудио
    func removeAll() {
        for id in meetings.keys { deleteAudio(meetingId: id) }
        meetings.removeAll()
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(meetings) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
