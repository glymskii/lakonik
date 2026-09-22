import Foundation
import Observation

/// Кеш шаблонов встреч (обновляется при старте и по pull-to-refresh).
@Observable
@MainActor
final class TemplateStore {
    private(set) var groups: [TemplateGroup] = []
    private(set) var categories: [TemplateCategory] = []
    private(set) var templates: [MeetingTemplate] = []
    private(set) var loadedAt: Date?
    var lastError: String?

    private static let cacheURL = URL.documentsDirectory.appending(path: "templates-cache.json")

    init() { loadCache() }

    func refresh(force: Bool = false) async {
        if !force, let loadedAt, Date().timeIntervalSince(loadedAt) < 600 { return }
        do {
            let r = try await APIClient.shared.templates()
            apply(r)
            if let data = try? JSONEncoder().encode(r) { try? data.write(to: Self.cacheURL, options: .atomic) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func templates(in group: String) -> [MeetingTemplate] {
        templates.filter { $0.group == group }.sorted { $0.sortOrder < $1.sortOrder }
    }

    func template(id: String) -> MeetingTemplate? { templates.first { $0.id == id } }
    func group(code: String) -> TemplateGroup? { groups.first { $0.code == code } }

    /// Недавно использованные (по коду) — для быстрого старта
    var recentCodes: [String] {
        get { UserDefaults.standard.stringArray(forKey: "recentTemplateCodes") ?? [] }
        set { UserDefaults.standard.set(Array(newValue.prefix(4)), forKey: "recentTemplateCodes") }
    }

    func markUsed(_ t: MeetingTemplate) {
        var r = recentCodes.filter { $0 != t.code }
        r.insert(t.code, at: 0)
        recentCodes = r
    }

    private func apply(_ r: TemplatesResponse) {
        groups = r.groups.sorted { $0.order < $1.order }
        categories = r.categories.sorted { $0.order < $1.order }
        templates = r.templates
        loadedAt = Date()
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: Self.cacheURL), let r = try? JSONDecoder().decode(TemplatesResponse.self, from: data) else { return }
        apply(r)
        loadedAt = nil // кеш есть, но обновить при первой возможности
    }
}
