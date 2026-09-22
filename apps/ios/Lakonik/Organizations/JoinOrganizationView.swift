import SwiftUI

/// Вступление по ссылке-приглашению: вставить ссылку или код → показать организацию → вступить
@MainActor
struct JoinOrganizationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    var initialToken: String? = nil
    @State private var text = ""
    @State private var token: String?
    @State private var info: JoinInfo?
    @State private var busy = false
    @State private var error: String?
    @State private var joined: OrganizationBrief?

    var body: some View {
        NavigationStack {
            Form {
                if let joined {
                    Section {
                        Label("Вы в организации «\(joined.name)»", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } footer: { Text("Пространство переключено на организацию.") }
                } else if let info, let token {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Вас приглашают в").font(.caption).foregroundStyle(.secondary)
                            Text(info.organizationName).font(.title3.weight(.semibold))
                            Text("Участников: \(info.membersCount)").font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        Button { Task { await join(token) } } label: {
                            HStack { if busy { ProgressView() }; Text("Вступить") }.frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent).disabled(busy)
                    } footer: {
                        Text("Встречи, которые вы запишете в этой организации, останутся в ней; личное пространство не меняется.")
                    }
                    if let error { Section { ErrorBanner(message: error) } }
                } else {
                    Section {
                        TextField("Ссылка или код приглашения", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button { Task { await lookup() } } label: {
                            HStack { if busy { ProgressView() }; Text("Проверить") }.frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent).disabled(busy || WorkspaceStore.joinToken(from: text) == nil)
                    } footer: {
                        Text("Ссылку lakonik.app/join/… присылает администратор организации. Если открыть её на iPhone с установленным Lakonik, этот экран появится сам.")
                    }
                    if let error { Section { ErrorBanner(message: error) } }
                }
            }
            .navigationTitle("Присоединиться")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(joined == nil ? "Отмена" : "Готово") { dismiss() } } }
            .task { if let t = initialToken { text = t; await lookup() } }
        }
    }

    private func lookup() async {
        guard let t = WorkspaceStore.joinToken(from: text) else { return }
        busy = true; error = nil
        defer { busy = false }
        do { info = try await APIClient.shared.joinInfo(token: t); token = t } catch { self.error = error.localizedDescription }
    }

    private func join(_ t: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let org = try await APIClient.shared.join(token: t)
            joined = org
            await WorkspaceStore.shared.adopt(org, auth: auth)
        } catch { self.error = error.localizedDescription }
    }
}
