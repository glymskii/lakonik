import SwiftUI

/// Переключатель пространства в заголовке списка: личное / организации, создать, присоединиться
@MainActor
struct WorkspaceMenu: View {
    @Environment(AuthService.self) private var auth
    @State private var store = WorkspaceStore.shared
    @State private var showCreate = false
    @State private var showJoin = false

    var body: some View {
        Menu {
            ForEach(store.all) { org in
                Button {
                    store.select(org)
                } label: {
                    if org.id == store.current?.id {
                        Label(org.name, systemImage: "checkmark")
                    } else {
                        Label(org.name, systemImage: org.isPersonal ? "person" : "building.2")
                    }
                }
            }
            if !store.suggested.isEmpty {
                Divider()
                ForEach(store.suggested) { s in
                    Button { Task { await joinSuggested(s) } } label: { Label("Вступить в «\(s.name)»", systemImage: "person.badge.plus") }
                }
            }
            Divider()
            Button { showCreate = true } label: { Label("Создать организацию", systemImage: "plus") }
            Button { showJoin = true } label: { Label("Присоединиться по ссылке", systemImage: "link") }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.isPersonal ? "person.crop.circle" : "building.2.crop.circle")
                Text(store.current?.name ?? "Личное").lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(.subheadline.weight(.medium))
        }
        .sheet(isPresented: $showCreate) { CreateOrganizationView() }
        .sheet(isPresented: $showJoin) { JoinOrganizationView() }
    }

    private func joinSuggested(_ s: SuggestedOrg) async {
        if let org = try? await APIClient.shared.joinByDomain(s.id) { await store.adopt(org, auth: auth) }
    }
}
