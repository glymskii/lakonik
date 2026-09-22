import Foundation

/// Запись онлайн-встречи (Meet, Zoom, Teams) через системную трансляцию экрана: расширение ReplayKit пишет два трека —
/// звук приложения (участники) и микрофон (ваш голос, в т.ч. AirPods) — в контейнер App Group, приложение потом
/// сводит их в один файл и отправляет как импорт. Этот файл общий для приложения и расширения.
struct BroadcastManifest: Codable, Identifiable, Equatable {
    enum State: String, Codable { case recording, finished, failed }

    let id: String
    var startedAt: Date
    var endedAt: Date?
    var state: State
    var error: String?
    var appFile: String
    var micFile: String
    /// Время первого буфера каждого трека (секунды host-clock) — для выравнивания при сведении
    var appStartSec: Double?
    var micStartSec: Double?
    var appBuffers: Int = 0
    var micBuffers: Int = 0
    var durationSec: Double = 0
    var imported: Bool = false
    /// Расширение обновляет раз в секунду — приложение по этому полю понимает, что трансляция жива
    var heartbeatAt: Date

    var hasAppAudio: Bool { appBuffers > 0 }
    var hasMicAudio: Bool { micBuffers > 0 }
}

enum BroadcastStore {
    static let groupId = "group.kz.adv.meetings"
    static let extensionBundleId = "kz.adv.meetings.broadcast"
    private static let stopKey = "broadcast.stopRequested"

    static var containerURL: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId) }

    /// Расширение трансляции встроено в сборку (без него запись онлайн-встреч недоступна)
    static var isAvailable: Bool {
        guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
        return FileManager.default.fileExists(atPath: plugins.appending(path: "LakonikBroadcast.appex").path) && containerURL != nil
    }

    static var sessionsDir: URL? {
        guard let c = containerURL else { return nil }
        let dir = c.appending(path: "Broadcasts", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func sessionDir(_ id: String) -> URL? {
        guard let s = sessionsDir else { return nil }
        let dir = s.appending(path: id, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func manifestURL(_ id: String) -> URL? { sessionDir(id)?.appending(path: "manifest.json") }

    static func save(_ m: BroadcastManifest) {
        guard let url = manifestURL(m.id), let data = try? JSONEncoder.iso.encode(m) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load(_ id: String) -> BroadcastManifest? {
        guard let url = manifestURL(id), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder.iso.decode(BroadcastManifest.self, from: data)
    }

    static func all() -> [BroadcastManifest] {
        guard let s = sessionsDir, let ids = try? FileManager.default.contentsOfDirectory(atPath: s.path) else { return [] }
        return ids.compactMap(load).sorted { $0.startedAt > $1.startedAt }
    }

    /// Живая трансляция: состояние recording и heartbeat не старше 10 с
    static func active() -> BroadcastManifest? {
        all().first { $0.state == .recording && Date().timeIntervalSince($0.heartbeatAt) < 10 }
    }

    static func remove(_ id: String) {
        guard let dir = sessionDir(id) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// Приложение просит расширение завершить трансляцию (расширение проверяет флаг раз в секунду)
    static var stopRequested: Bool {
        get { UserDefaults(suiteName: groupId)?.bool(forKey: stopKey) ?? false }
        set { UserDefaults(suiteName: groupId)?.set(newValue, forKey: stopKey) }
    }
}

extension JSONEncoder {
    static let iso: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
}
extension JSONDecoder {
    static let iso: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()
}
