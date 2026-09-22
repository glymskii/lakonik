import SwiftUI

/// Выбор ответственного из общего справочника + добавление нового (сразу попадает в базу для всех устройств).
@MainActor
struct PeoplePickerView: View {
    let selected: Person?
    let onSelect: (Person?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var people: [Person] = []
    @State private var users: [AccountUser] = []
    @State private var query = ""
    @State private var showAdd = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Button {
                    onSelect(nil); dismiss()
                } label: {
                    HStack { Label("Не назначен", systemImage: "person.slash"); Spacer(); if selected == nil { Image(systemName: "checkmark").foregroundStyle(.tint) } }
                }
                .foregroundStyle(.primary)
            }
            Section {
                ForEach(filtered) { p in
                    Button {
                        onSelect(p); dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name)
                                if !p.subtitle.isEmpty { Text(p.subtitle).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if let n = p.openTasks, n > 0 { Text("\(n)").font(.caption).foregroundStyle(.secondary) }
                            if selected?.id == p.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    .foregroundStyle(.primary)
                }
                if !query.trimmingCharacters(in: .whitespaces).isEmpty && !filtered.contains(where: { $0.name.lowercased() == query.lowercased() }) {
                    Button { showAdd = true } label: { Label("Добавить «\(query)»", systemImage: "person.badge.plus") }
                }
            } header: {
                Text("Справочник")
            } footer: {
                Text("Новые люди сохраняются в общую базу и доступны на всех устройствах.")
            }
            if !filteredUsers.isEmpty {
                Section {
                    ForEach(filteredUsers) { u in
                        Button { Task { await pickUser(u) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(u.displayName).foregroundStyle(.primary)
                                Text([u.email, u.agencyName].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Коллеги")
                } footer: {
                    Text("Выбор коллеги добавит его в справочник ответственных.")
                }
            }
            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Ответственный")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Имя, роль или компания")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showAdd = true } label: { Image(systemName: "plus") } } }
        .task { await load() }
        .sheet(isPresented: $showAdd) {
            PersonFormView(initialName: query) { p in
                await load()
                onSelect(p); dismiss()
            }
        }
    }

    private var filtered: [Person] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return people }
        return people.filter { $0.name.lowercased().contains(q) || $0.subtitle.lowercased().contains(q) }
    }

    /// Аккаунты, которых ещё нет в справочнике (по имени или почте)
    private var filteredUsers: [AccountUser] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let knownNames = Set(people.map { $0.name.lowercased() })
        let knownEmails = Set(people.compactMap { $0.email?.lowercased() })
        return users.filter { u in
            let name = u.name.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !knownNames.contains(name.lowercased()), !knownEmails.contains(u.email.lowercased()) else { return false }
            return q.isEmpty || name.lowercased().contains(q) || u.email.lowercased().contains(q)
        }
    }

    private func pickUser(_ u: AccountUser) async {
        do {
            let p = try await APIClient.shared.createPerson(PersonBody(name: u.name.trimmingCharacters(in: .whitespaces), role: nil, company: u.agencyName, email: u.email, isActive: nil))
            onSelect(p); dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func load() async {
        do {
            async let p = APIClient.shared.people()
            async let u = APIClient.shared.users()
            people = try await p
            users = (try? await u) ?? []
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
struct PersonFormView: View {
    var initialName = ""
    var person: Person? = nil
    let onDone: (Person) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var role: String
    @State private var company: String
    @State private var email: String
    @State private var busy = false
    @State private var error: String?

    init(initialName: String = "", person: Person? = nil, onDone: @escaping (Person) async -> Void) {
        self.initialName = initialName
        self.person = person
        self.onDone = onDone
        _name = State(initialValue: person?.name ?? initialName)
        _role = State(initialValue: person?.role ?? "")
        _company = State(initialValue: person?.company ?? "")
        _email = State(initialValue: person?.email ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Человек") {
                    TextField("Имя и фамилия", text: $name).textContentType(.name)
                    TextField("Роль / должность", text: $role)
                    TextField("Компания / агентство", text: $company)
                    TextField("Почта (необязательно)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .navigationTitle(person == nil ? "Новый ответственный" : "Ответственный")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Сохранить") { Task { await save() } }.disabled(busy || name.trimmingCharacters(in: .whitespaces).count < 2) }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        busy = true; defer { busy = false }
        let body = PersonBody(name: name.trimmingCharacters(in: .whitespaces), role: role.isEmpty ? nil : role, company: company.isEmpty ? nil : company, email: email.isEmpty ? nil : email.lowercased(), isActive: nil)
        do {
            let p = person == nil ? try await APIClient.shared.createPerson(body) : try await APIClient.shared.updatePerson(person!.id, body)
            await onDone(p)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

/// Управление справочником: список, правка, скрытие.
@MainActor
struct PeopleManagerView: View {
    @State private var people: [Person] = []
    @State private var editing: Person?
    @State private var showAdd = false
    @State private var query = ""
    @State private var error: String?

    var body: some View {
        List {
            ForEach(people.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query) }) { p in
                Button { editing = p } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(p.name).foregroundStyle(.primary)
                                if p.source == "ai" { Text("из отчёта").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2).background(Color.secondary.opacity(0.15), in: Capsule()).foregroundStyle(.secondary) }
                            }
                            if !p.subtitle.isEmpty { Text(p.subtitle).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if let n = p.openTasks, n > 0 { Text("\(n) откр.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .swipeActions {
                    Button(role: .destructive) { Task { try? await APIClient.shared.deletePerson(p.id); await load() } } label: { Label("Скрыть", systemImage: "eye.slash") }
                }
            }
            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Ответственные")
        .searchable(text: $query)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showAdd = true } label: { Image(systemName: "plus") } } }
        .task { await load() }
        .sheet(item: $editing) { p in PersonFormView(person: p) { _ in await load() } }
        .sheet(isPresented: $showAdd) { PersonFormView { _ in await load() } }
    }

    private func load() async {
        do { people = try await APIClient.shared.people(); error = nil } catch { self.error = error.localizedDescription }
    }
}
