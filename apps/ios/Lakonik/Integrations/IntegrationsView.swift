import AuthenticationServices
import SwiftUI

/// Подключение записей Google Meet и Zoom: авторизация у провайдера через системное окно, дальше записи встреч
/// появляются в списке сами (сервер проверяет новые записи раз в 10 минут).
@MainActor
struct IntegrationsView: View {
    @State private var items: [Integration] = []
    @State private var loading = true
    @State private var busy: String?
    @State private var error: String?
    @State private var session: ASWebAuthenticationSession?
    @State private var presenter = WebAuthPresenter()

    private let providers: [(id: String, title: String, icon: String, hint: String)] = [
        ("google_meet", "Google Meet", "video", "Нужен Google Workspace с включённой записью встреч (Business Standard и выше). Запись включает организатор кнопкой или администратор — автоматически."),
        ("zoom", "Zoom", "video.badge.waveform", "Нужен план Zoom Pro и выше с облачной записью. Запись включает организатор."),
    ]

    var body: some View {
        List {
            Section {
                Text("Записи онлайн-встреч будут импортироваться сами: через несколько минут после появления файла у провайдера встреча с расшифровкой и отчётом появится в текущем пространстве. Часы считаются как обычный импорт.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(providers, id: \.id) { p in
                Section {
                    if let i = items.first(where: { $0.provider == p.id }) {
                        LabeledContent("Аккаунт", value: i.accountEmail ?? "—")
                        Toggle("Импортировать записи автоматически", isOn: Binding(get: { i.autoImport }, set: { v in Task { await run(p.id) { try await APIClient.shared.updateIntegration(provider: p.id, autoImport: v) } } }))
                        if let s = i.lastSyncAt { LabeledContent("Последняя проверка", value: s.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "ru_RU")))) }
                        if i.status == "error", let e = i.lastError { Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange) }
                        Button { Task { await run(p.id) { try await APIClient.shared.syncIntegration(provider: p.id) } } } label: { Label("Проверить записи сейчас", systemImage: "arrow.clockwise") }.disabled(busy != nil)
                        if i.status == "error" {
                            Button { Task { await connect(p.id) } } label: { Label("Подключить заново", systemImage: "link") }.disabled(busy != nil)
                        }
                        Button(role: .destructive) { Task { await run(p.id) { try await APIClient.shared.disconnectIntegration(provider: p.id) } } } label: { Label("Отключить", systemImage: "xmark.circle") }.disabled(busy != nil)
                    } else {
                        Button { Task { await connect(p.id) } } label: {
                            HStack { if busy == p.id { ProgressView() }; Label("Подключить \(p.title)", systemImage: "link") }
                        }
                        .disabled(busy != nil || loading)
                    }
                } header: {
                    Label(p.title, systemImage: p.icon)
                } footer: {
                    Text(p.hint)
                }
            }
            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Интеграции")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .onOpenURL { url in
            // lakonik://integrations/callback?provider=…&status=ok|error&message=…
            guard url.scheme == "lakonik", url.host == "integrations" else { return }
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if q.first(where: { $0.name == "status" })?.value == "error" { error = q.first(where: { $0.name == "message" })?.value ?? "Не удалось подключить" }
            Task { await load() }
        }
    }

    private func load() async {
        do { items = try await APIClient.shared.integrations(); error = nil } catch {
            if case APIError.server(let status, _) = error, status == 404 { items = [] } else { self.error = error.localizedDescription }
        }
        loading = false
    }

    private func run(_ provider: String, _ op: () async throws -> Void) async {
        busy = provider; error = nil
        defer { busy = nil }
        do { try await op(); await load() } catch { self.error = error.localizedDescription }
    }

    /// Авторизация у провайдера в системном окне; сервер после callback редиректит на lakonik://integrations/callback
    private func connect(_ provider: String) async {
        busy = provider; error = nil
        defer { busy = nil }
        do {
            let url = try await APIClient.shared.integrationConnectURL(provider: provider)
            let result: Bool = await withCheckedContinuation { cont in
                let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "lakonik") { cb, err in
                    if let err, (err as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.error = err.localizedDescription }
                    if let cb, let q = URLComponents(url: cb, resolvingAgainstBaseURL: false)?.queryItems, q.first(where: { $0.name == "status" })?.value == "error" {
                        self.error = q.first(where: { $0.name == "message" })?.value ?? "Не удалось подключить"
                    }
                    cont.resume(returning: cb != nil)
                }
                s.presentationContextProvider = presenter
                s.prefersEphemeralWebBrowserSession = false
                session = s
                s.start()
            }
            if result { await load() }
        } catch { self.error = error.localizedDescription }
    }
}

final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}
