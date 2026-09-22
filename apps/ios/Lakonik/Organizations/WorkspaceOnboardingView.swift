import SwiftUI

/// Первый вход: как пользоваться — лично, создать организацию или присоединиться
@MainActor
struct WorkspaceOnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    @State private var store = WorkspaceStore.shared
    @State private var showCreate = false
    @State private var showJoin = false
    @State private var busy = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer(minLength: 12)
                Image(systemName: "person.2.circle").font(.system(size: 56)).foregroundStyle(.tint)
                Text("Как будете пользоваться?").font(.title2.bold())
                Text("Личное пространство уже готово. Организация нужна, чтобы работать с коллегами: общие задачи, справочник и шаблоны — при этом каждая встреча видна только автору и тем, с кем он поделился.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)

                if !store.suggested.isEmpty {
                    ForEach(store.suggested) { s in
                        Button { Task { await joinSuggested(s) } } label: {
                            HStack {
                                Image(systemName: "building.2.fill")
                                VStack(alignment: .leading) {
                                    Text("Вас ждут в «\(s.name)»").font(.headline)
                                    Text("\(s.membersCount) участников · по домену вашей почты").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if busy { ProgressView() } else { Text("Вступить").font(.subheadline.weight(.semibold)) }
                            }
                            .padding(14).background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain).disabled(busy)
                    }
                }

                VStack(spacing: 10) {
                    Button { dismiss() } label: { Label("Личное использование", systemImage: "person").frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.borderedProminent)
                    Button { showCreate = true } label: { Label("Создать организацию", systemImage: "plus").frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.bordered)
                    Button { showJoin = true } label: { Label("Присоединиться по ссылке", systemImage: "link").frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.bordered)
                }
                .padding(.horizontal)
                Spacer()
                Text("Всё это можно сделать позже из меню пространства в списке встреч.").font(.caption).foregroundStyle(.secondary)
            }
            .padding()
            .sheet(isPresented: $showCreate, onDismiss: { if !store.teams.isEmpty { dismiss() } }) { CreateOrganizationView() }
            .sheet(isPresented: $showJoin, onDismiss: { if !store.teams.isEmpty { dismiss() } }) { JoinOrganizationView() }
        }
    }

    private func joinSuggested(_ s: SuggestedOrg) async {
        busy = true; defer { busy = false }
        if let org = try? await APIClient.shared.joinByDomain(s.id) { await store.adopt(org, auth: auth); dismiss() }
    }
}
