import SwiftUI

@MainActor
struct SettingsView: View {
    @Environment(AuthService.self) private var auth
    @State private var retention = AudioRetention.current
    @State private var apiOverride = UserDefaults.standard.string(forKey: AppConfig.overrideKey) ?? ""
    @State private var localMeetings: [LocalMeeting] = []
    @State private var confirmSignOut = false
    @State private var name = ""

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
                        if let a = me.agencyName { LabeledContent("Агентство", value: a) }
                        LabeledContent("Роль", value: me.role == "member" ? "Сотрудник" : me.role)
                    }
                    Button("Выйти", role: .destructive) { confirmSignOut = true }
                } header: {
                    Text("Аккаунт")
                } footer: {
                    Text("Имя подставляется в транскрипт и отчёт, когда вы отмечаете себя среди спикеров («Это я»).")
                }
                Section("Задачи и сроки") {
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
                Section("О приложении") {
                    LabeledContent("Версия", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "")
                    Text("Lakonik — запись встреч, расшифровка, отчёт и задачи.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Настройки")
            .task { await reload(); name = auth.me?.name ?? "" }
            .onChange(of: auth.me?.name) { _, v in if let v, name.isEmpty { name = v } }
            .confirmationDialog("Выйти из аккаунта?", isPresented: $confirmSignOut) {
                Button("Выйти", role: .destructive) { Task { await auth.signOut() } }
            }
        }
    }

    private func reload() async { localMeetings = await LocalStore.shared.withAudioOrPending() }
}
