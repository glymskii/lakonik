import SwiftUI

@MainActor
struct CreateOrganizationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var created: Organization?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    Section {
                        Label("Организация «\(created.name)» создана", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        if let link = created.inviteLink {
                            ShareLink(item: URL(string: link)!, subject: Text("Приглашение в \(created.name)"), message: Text("Присоединяйтесь к «\(created.name)» в Lakonik: \(link)")) {
                                Label("Поделиться ссылкой-приглашением", systemImage: "square.and.arrow.up")
                            }
                        }
                    } footer: {
                        Text("Отправьте ссылку коллегам — по ней они попадут в организацию. Управлять участниками и приглашениями можно в Настройках → Организация.")
                    }
                } else {
                    Section {
                        TextField("Название организации", text: $name).focused($focused).onSubmit { Task { await create() } }
                    } footer: {
                        Text("Вы станете владельцем. Встречи, задачи и справочник организации видны только её участникам, а содержимое встреч — только автору и тем, с кем он поделился.")
                    }
                    if let error { Section { ErrorBanner(message: error) } }
                }
            }
            .navigationTitle("Новая организация")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(created == nil ? "Отмена" : "Готово") { dismiss() } }
                if created == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await create() } } label: { if busy { ProgressView() } else { Text("Создать") } }
                            .disabled(busy || name.trimmingCharacters(in: .whitespaces).count < 2)
                    }
                }
            }
            .onAppear { focused = true }
        }
    }

    private func create() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let org = try await APIClient.shared.createOrganization(name: name.trimmingCharacters(in: .whitespaces))
            created = org
            await WorkspaceStore.shared.adopt(org.brief, auth: auth)
        } catch { self.error = error.localizedDescription }
    }
}
