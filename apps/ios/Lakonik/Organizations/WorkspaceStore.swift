import Foundation
import Observation
import os

extension Notification.Name {
    /// Сменилось активное пространство — списки перезагружаются
    static let workspaceChanged = Notification.Name("kz.adv.meetings.workspaceChanged")
}

/// Активное пространство (личное или организация). Выбор хранится на устройстве отдельно для каждого аккаунта;
/// каждый запрос к данным несёт его в заголовке X-Organization-Id (см. APIClient.organizationProvider).
@Observable
@MainActor
final class WorkspaceStore {
    static let shared = WorkspaceStore()
    private let log = Logger(subsystem: "kz.adv.meetings", category: "workspace")

    private(set) var all: [OrganizationBrief] = []
    private(set) var current: OrganizationBrief?
    private(set) var userId: String?
    /// Организации, куда можно вступить по домену почты (показываются в онбординге и меню)
    private(set) var suggested: [SuggestedOrg] = []
    /// Токен из ссылки lakonik.app/join/<token>, ждущий входа или подтверждения
    var pendingJoinToken: String?
    var showOnboarding = false

    private init() {
        APIClient.shared.organizationProvider = { [weak self] in
            // Доступ к @MainActor-свойству из любого потока: выбор дублируется в UserDefaults
            _ = self
            return UserDefaults.standard.string(forKey: WorkspaceStore.activeKey)
        }
    }

    private static let activeKey = "workspace.active"
    private static func savedKey(_ userId: String) -> String { "workspace.\(userId)" }
    private static func onboardedKey(_ userId: String) -> String { "workspace.onboarded.\(userId)" }

    var isPersonal: Bool { current?.isPersonal ?? true }
    var teams: [OrganizationBrief] { all.filter { !$0.isPersonal } }
    var personal: OrganizationBrief? { all.first { $0.isPersonal } }

    /// Профиль обновился: синхронизировать список и выбрать пространство (сохранённое → по умолчанию с сервера → личное)
    func apply(me: Me) {
        userId = me.id
        all = me.organizations
        let d = UserDefaults.standard
        let saved = d.string(forKey: Self.savedKey(me.id))
        let pick = all.first { $0.id == saved } ?? all.first { $0.id == me.defaultOrganizationId } ?? all.first { !$0.isPersonal } ?? all.first
        let changed = pick?.id != current?.id
        current = pick
        d.set(pick?.id, forKey: Self.activeKey)
        if let pick { d.set(pick.id, forKey: Self.savedKey(me.id)) }
        if changed { NotificationCenter.default.post(name: .workspaceChanged, object: nil) }
        // Онбординг: один раз, если нет ни одной команды
        if !d.bool(forKey: Self.onboardedKey(me.id)) {
            d.set(true, forKey: Self.onboardedKey(me.id))
            if teams.isEmpty, !all.isEmpty { showOnboarding = true }
        }
        Task { await refreshSuggested() }
    }

    func select(_ org: OrganizationBrief) {
        guard org.id != current?.id else { return }
        current = org
        UserDefaults.standard.set(org.id, forKey: Self.activeKey)
        if let userId { UserDefaults.standard.set(org.id, forKey: Self.savedKey(userId)) }
        log.info("workspace → \(org.name, privacy: .public)")
        NotificationCenter.default.post(name: .workspaceChanged, object: nil)
    }

    /// После создания/вступления: перечитать профиль и переключиться на новую организацию
    func adopt(_ org: OrganizationBrief, auth: AuthService) async {
        await auth.refreshMe()
        if let fresh = all.first(where: { $0.id == org.id }) { select(fresh) } else { all.append(org); select(org) }
    }

    func refreshSuggested() async {
        suggested = (try? await APIClient.shared.suggestedOrganizations()) ?? []
    }

    func clear() {
        all = []; current = nil; userId = nil; suggested = []; pendingJoinToken = nil; showOnboarding = false
        UserDefaults.standard.removeObject(forKey: Self.activeKey)
    }

    /// Ссылка-приглашение: lakonik.app/join/<token> (Universal Link) или вставленный текст с токеном
    static func joinToken(from text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: t), let host = url.host, host.hasSuffix("lakonik.app") {
            let parts = url.pathComponents.filter { $0 != "/" }
            if parts.first == "join", parts.count >= 2 { return parts[1] }
            return nil
        }
        return t.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil ? t : nil
    }
}
