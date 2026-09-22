import Foundation

/// Конфигурация приложения. Базовый URL API берётся из Info.plist (API_BASE_URL, задаётся по конфигурации сборки),
/// его можно переопределить в настройках (для тестов против другого сервера).
enum AppConfig {
    static let overrideKey = "apiBaseURLOverride"
    /// Корпоративный вход: выбранный сервер организации (её код, название и адрес API)
    static let orgServerKey = "orgServerBaseURL"
    static let orgCodeKey = "orgServerCode"
    static let orgNameKey = "orgServerName"

    static var defaultBaseURL: URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String) ?? "http://localhost:3000"
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
    }

    /// Сервер, с которым работает приложение: ручное переопределение (Debug) → сервер организации → сервер по умолчанию
    static var apiBaseURL: URL {
        if let s = UserDefaults.standard.string(forKey: overrideKey), let u = URL(string: s), !s.isEmpty { return u }
        if let s = UserDefaults.standard.string(forKey: orgServerKey), let u = URL(string: s), !s.isEmpty { return u }
        return defaultBaseURL
    }

    /// Адрес справочника организаций — всегда сервер по умолчанию: по коду он отдаёт адрес корпоративного сервера
    static var discoveryBaseURL: URL { defaultBaseURL }

    static var selectedOrg: (code: String, name: String)? {
        let d = UserDefaults.standard
        guard let code = d.string(forKey: orgCodeKey), let name = d.string(forKey: orgNameKey), !code.isEmpty else { return nil }
        return (code, name)
    }

    static func selectOrg(code: String, name: String, apiBaseUrl: String) {
        let d = UserDefaults.standard
        d.set(apiBaseUrl, forKey: orgServerKey)
        d.set(code, forKey: orgCodeKey)
        d.set(name, forKey: orgNameKey)
    }

    static func clearOrg() {
        let d = UserDefaults.standard
        for k in [orgServerKey, orgCodeKey, orgNameKey] { d.removeObject(forKey: k) }
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
