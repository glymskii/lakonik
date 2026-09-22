import SwiftUI

/// Кто этот спикер: коллега из аккаунтов, человек из справочника, клиент/вендор без имени, произвольное имя, «Это я».
@MainActor
struct SpeakerPickerView: View {
    let speakerId: String
    let transcript: Transcript
    let onApply: (_ name: String?, _ role: SpeakerRole?, _ isSelf: Bool) async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    @State private var users: [AccountUser] = []
    @State private var people: [Person] = []
    @State private var query = ""
    @State private var customName: String
    @State private var role: SpeakerRole?
    @State private var busy = false

    init(speakerId: String, transcript: Transcript, onApply: @escaping (_ name: String?, _ role: SpeakerRole?, _ isSelf: Bool) async -> Void) {
        self.speakerId = speakerId
        self.transcript = transcript
        self.onApply = onApply
        _customName = State(initialValue: transcript.speakers[speakerId] ?? "")
        _role = State(initialValue: transcript.speakerRoles[speakerId])
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { Task { await apply(name: auth.me?.name, role: .ours, isSelf: true) } } label: {
                        Label(transcript.selfSpeakerId == speakerId ? "Это я ✓" : "Это я", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    Picker("Сторона", selection: $role) {
                        Text("не указана").tag(SpeakerRole?.none)
                        ForEach(SpeakerRole.allCases, id: \.self) { r in Text(r.title).tag(SpeakerRole?.some(r)) }
                    }
                    .pickerStyle(.segmented)
                    if role == .client || role == .vendor {
                        Button { Task { await apply(name: "", role: role, isSelf: false) } } label: {
                            Label("Без имени — подписать «\(role!.title) N»", systemImage: "number")
                        }
                    }
                } header: {
                    Text(transcript.label(for: speakerId))
                } footer: {
                    Text("Клиенты и вендоры без имени нумеруются отдельно внутри этой записи: «Клиент 1», «Клиент 2». В отчёт попадут выбранная сторона и имя.")
                }

                Section("Имя вручную") {
                    HStack {
                        TextField("Имя и фамилия", text: $customName)
                        Button("Сохранить") { Task { await apply(name: customName, role: role, isSelf: false) } }
                            .disabled(customName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                Section("Коллеги") {
                    ForEach(filteredUsers) { u in
                        Button { Task { await apply(name: u.displayName, role: .ours, isSelf: u.id == auth.me?.id) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(u.displayName).foregroundStyle(.primary)
                                Text([u.email, u.agencyName].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if filteredUsers.isEmpty { Text("Никого не найдено").foregroundStyle(.secondary) }
                }

                Section("Справочник ответственных") {
                    ForEach(filteredPeople) { p in
                        Button { Task { await apply(name: p.name, role: role, isSelf: false) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).foregroundStyle(.primary)
                                if !p.subtitle.isEmpty { Text(p.subtitle).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    if filteredPeople.isEmpty { Text("Никого не найдено").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Кто это?")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Имя или почта")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
            .task {
                async let u = APIClient.shared.users()
                async let p = APIClient.shared.people()
                users = (try? await u) ?? []
                people = (try? await p) ?? []
            }
            .disabled(busy)
        }
    }

    private var filteredUsers: [AccountUser] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? users : users.filter { $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q) }
    }
    private var filteredPeople: [Person] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? people : people.filter { $0.name.lowercased().contains(q) || $0.subtitle.lowercased().contains(q) }
    }

    private func apply(name: String?, role: SpeakerRole?, isSelf: Bool) async {
        busy = true
        await onApply(name, role, isSelf)
        busy = false
        dismiss()
    }
}
