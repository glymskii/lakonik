import Foundation

/// Конфигурация приложения. Базовый URL API берётся из Info.plist (API_BASE_URL, задаётся по конфигурации сборки),
/// его можно переопределить в настройках (для тестов против другого сервера).
enum AppConfig {
    static let overrideKey = "apiBaseURLOverride"

    static var defaultBaseURL: URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String) ?? "http://localhost:3000"
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
    }

    static var apiBaseURL: URL {
        if let s = UserDefaults.standard.string(forKey: overrideKey), let u = URL(string: s), !s.isEmpty { return u }
        return defaultBaseURL
    }

    /// Длительность одного сегмента записи (секунды)
    static let segmentDuration: TimeInterval = 300
    #if DEBUG
    static let isDebug = true
    #else
    static let isDebug = false
    #endif
    static let appGroupless = true
}
