import SwiftUI
import UIKit

@MainActor
struct SettingsView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.openURL) private var openURL
    @State private var retention = AudioRetention.current
    @State private var apiOverride = UserDefaults.standard.string(forKey: AppConfig.overrideKey) ?? ""
    @State private var localMeetings: [LocalMeeting] = []
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var deleteText = ""
    @State private var deleteError: String?
    @State private var name = ""
    @State private var workspace = WorkspaceStore.shared
    @State private var showPaywall = false
    @State private var entitlements = EntitlementStore.shared

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let me = auth.me {
                        HStack {
                            Text("Имя")
                            Spacer()
                            TextField("Как вас зовут", text: $name)
                                .multilineTextAlignment(.trailing)
                                .textContentType(.name)
                                .onSubmit { Task { try? await auth.updateName(name) } }
                        }
                        LabeledContent("Почта", value: me.email)
                    }
                    Button("Выйти", role: .destructive) { confirmSignOut = true }
                } header: {
                    Text("Аккаунт")
                } footer: {
                    Text("Имя подставляется в транскрипт и отчёт, когда вы отмечаете себя среди спикеров («Это я»).")
                }
                Section {
                    ForEach(workspace.all) { org in
                        if org.isPersonal {
                            HStack {
                                Label(org.name, systemImage: "person")
                                Spacer()
                                if org.id == workspace.current?.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                            .contentShape(Rectangle()).onTapGesture { workspace.select(org) }
                        } else {
                            NavigationLink { OrganizationView(orgId: org.id) } label: {
                                HStack {
                                    Label(org.name, systemImage: "building.2")
                                    Spacer()
                                    Text(org.roleTitle).font(.caption).foregroundStyle(.secondary)
                                    if org.id == workspace.current?.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                }
                            }
                        }
                    }
                } header: {
                    Text("Пространства")
                } footer: {
                    Text("Галочкой отмечено активное пространство — в нём создаются записи. Переключить можно и в списке встреч.")
                }
                Section {
                    Button { showPaywall = true } label: {
                        HStack {
                            Label("Тариф", systemImage: "star.circle")
                            Spacer()
                            Text(entitlements.entitlement?.tierTitle ?? "—").foregroundStyle(.secondary)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(.primary)
                } footer: {
                    if let e = entitlements.entitlement, let limit = e.limits.monthlyLimitSec {
                        Text("Использовано \(Fmt.hours(e.usage.monthlySec)) из \(Fmt.hours(limit)) в этом месяце.")
                    } else if let e = entitlements.entitlement, e.tier == "free" {
                        Text("Бесплатно: записи до 5 минут, до 5 записей в день.")
                    }
                }
                Section("Задачи и сроки") {
                    NavigationLink { IntegrationsView() } label: { Label("Интеграции: Meet, Zoom", systemImage: "video.badge.checkmark") }
                    NavigationLink { DeadlineSettingsView() } label: { Label("Сроки задач и отчётов", systemImage: "calendar.badge.clock") }
                    NavigationLink { PeopleManagerView() } label: { Label("Справочник ответственных", systemImage: "person.2") }
                }
                Section {
                    Picker("Аудио на устройстве", selection: $retention) {
                        ForEach(AudioRetention.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .onChange(of: retention) { _, v in AudioRetention.current = v }
                } header: {
                    Text("Хранение аудио")
                } footer: {
                    Text("На сервере аудио удаляется сразу после расшифровки — хранятся только транскрипт и отчёт. Локальная копия нужна только для повторной отправки при сбое.")
                }
                Section {
                    if localMeetings.isEmpty { Text("Аудио на устройстве нет").foregroundStyle(.secondary) }
                    ForEach(localMeetings) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.title).font(.subheadline)
                            Text("\(m.phase.title) · сегментов \(m.segments.count), загружено \(m.uploadedCount) · \(Fmt.duration(Int(m.recordedSeconds)))").font(.caption).foregroundStyle(.secondary)
                            if let e = m.finalizeError { Text(e).font(.caption2).foregroundStyle(.red) }
                        }
                    }
                    .onDelete { idx in Task { for i in idx { let id = localMeetings[i].id; await LocalStore.shared.remove(id); await UploadManager.shared.cancel(meetingId: id) }; await reload() } }
                    if localMeetings.contains(where: { $0.phase == .stopped }) {
                        Button("Повторить отправку незавершённых") { Task { await RecordingCoordinator.shared.resumePendingFinalizations(); await reload() } }
                    }
                } header: {
                    Text("Аудио на устройстве (\(localMeetings.count))")
                } footer: {
                    Text("Записи, аудио которых ещё хранится на телефоне. Смахните влево, чтобы удалить.")
                }
                #if DEBUG
                Section {
                    TextField("URL сервера (пусто = по умолчанию)", text: $apiOverride).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { UserDefaults.standard.set(apiOverride, forKey: AppConfig.overrideKey) }
                    LabeledContent("Текущий", value: AppConfig.apiBaseURL.absoluteString).font(.caption)
                } header: { Text("Сервер (отладка)") } footer: { Text("Только в Debug-сборке. По умолчанию: \(AppConfig.defaultBaseURL.absoluteString)") }
                #endif
                Section {
                    Button { openURL(supportMailURL()) } label: { Label("Написать в поддержку", systemImage: "envelope") }
                    Link(destination: URL(string: "https://lakonik.app/support")!) { Label("Частые вопросы", systemImage: "questionmark.circle") }
                } header: {
                    Text("Поддержка")
                } footer: {
                    Text("В письмо подставятся версия приложения и идентификатор аккаунта — так мы быстрее найдём причину.")
                }
                Section {
                    Button("Удалить аккаунт", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Удаляются профиль, личное пространство со всеми записями и участие в организациях. Активная подписка отменяется в Настройках Apple ID.")
                }
                Section("О приложении") {
                    LabeledContent("Версия", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "")
                    Text("Lakonik — запись встреч, расшифровка, отчёт и задачи.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Настройки")
            .task { await reload(); name = auth.me?.name ?? ""; await entitlements.refresh() }
            .sheet(isPresented: $showPaywall) { PaywallView() }
            .onChange(of: auth.me?.name) { _, v in if let v, name.isEmpty { name = v } }
            .confirmationDialog("Выйти из аккаунта?", isPresented: $confirmSignOut) {
                Button("Выйти", role: .destructive) { Task { await auth.signOut() } }
            }
            .alert("Удалить аккаунт?", isPresented: $confirmDelete) {
                TextField("Введите УДАЛИТЬ", text: $deleteText)
                Button("Удалить", role: .destructive) { Task { await deleteAccount() } }.disabled(deleteText != "УДАЛИТЬ")
                Button("Отмена", role: .cancel) { deleteText = "" }
            } message: { Text("Это действие необратимо. Если вы единственный владелец организации с участниками — сначала передайте владение.") }
            .alert("Не удалось удалить аккаунт", isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
                Button("OK") { deleteError = nil }
            } message: { Text(deleteError ?? "") }
        }
    }

    private func reload() async { localMeetings = await LocalStore.shared.withAudioOrPending() }

    private func supportMailURL() -> URL {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? ""
        let body = "\n\n—\nLakonik \(version) (\(build)), iOS \(UIDevice.current.systemVersion), \(UIDevice.current.model)\nАккаунт: \(auth.me?.id ?? "—")\nПространство: \(workspace.current?.name ?? "—")"
        var c = URLComponents(string: "mailto:support@lakonik.app")!
        c.queryItems = [URLQueryItem(name: "subject", value: "Lakonik: вопрос"), URLQueryItem(name: "body", value: body)]
        return c.url!
    }

    private func deleteAccount() async {
        deleteText = ""
        do {
            try await APIClient.shared.deleteAccount()
            await LocalStore.shared.removeAll()
            auth.signOutLocally()
        } catch { deleteError = error.localizedDescription }
    }
}
