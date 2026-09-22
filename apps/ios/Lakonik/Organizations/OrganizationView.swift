import SwiftUI

/// Карточка организации: участники и роли, ссылка-приглашение, приглашения по почте, домены, план, словарь терминов,
/// передача владения, выход и удаление. Действия администратора показываются только admin/owner.
@MainActor
struct OrganizationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    let orgId: String
    @State private var org: Organization?
    @State private var error: String?
    @State private var busy = false
    @State private var inviteEmail = ""
    @State private var inviteRole = "member"
    @State private var keytermsText = ""
    @State private var editingName = ""
    @State private var removing: OrgMember?
    @State private var transferTarget: OrgMember?
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var confirmRotate = false

    private var myId: String { auth.me?.id ?? "" }

    var body: some View {
        Form {
            if let org {
                header(org)
                inviteSection(org)
                membersSection(org)
                if org.isAdmin, !org.pendingInvitations.isEmpty { pendingSection(org) }
                domainsSection(org)
                if org.isAdmin { keytermsSection(org) }
                dangerSection(org)
            } else if let error {
                Section { ErrorBanner(message: error) }
            } else {
                Section { HStack { ProgressView(); Text("Загрузка…") } }
            }
        }
        .navigationTitle(org?.name ?? "Организация")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Удалить участника?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { m in
            Button("Передать встречи мне и удалить") { Task { await remove(m, transferTo: myId) } }
            Button("Удалить вместе со встречами", role: .destructive) { Task { await remove(m, transferTo: nil) } }
            Button("Отмена", role: .cancel) {}
        } message: { m in Text("\(m.name) потеряет доступ к организации. Конфиденциальные встречи удаляются в любом случае.") }
        .confirmationDialog("Передать владение?", isPresented: Binding(get: { transferTarget != nil }, set: { if !$0 { transferTarget = nil } }), presenting: transferTarget) { m in
            Button("Передать \(m.name)") { Task { await transfer(to: m) } }
            Button("Отмена", role: .cancel) {}
        } message: { _ in Text("Вы останетесь администратором.") }
        .confirmationDialog("Покинуть организацию?", isPresented: $confirmLeave) {
            Button("Покинуть", role: .destructive) { Task { await leave() } }
        } message: { Text("Ваши встречи в организации перейдут её владельцу; конфиденциальные будут удалены.") }
        .confirmationDialog("Удалить организацию со всеми данными?", isPresented: $confirmDelete) {
            Button("Удалить безвозвратно", role: .destructive) { Task { await deleteOrg() } }
        } message: { Text("Встречи, расшифровки, отчёты, задачи и справочник всех участников будут удалены.") }
        .confirmationDialog("Перевыпустить ссылку?", isPresented: $confirmRotate) {
            Button("Перевыпустить", role: .destructive) { Task { await rotate() } }
        } message: { Text("Старая ссылка-приглашение перестанет работать.") }
    }

    // MARK: Секции

    @ViewBuilder private func header(_ org: Organization) -> some View {
        Section {
            if org.isAdmin {
                HStack {
                    Text("Название")
                    Spacer()
                    TextField("Название", text: $editingName).multilineTextAlignment(.trailing)
                        .onSubmit { Task { await patch(PatchOrgBody(name: editingName)) } }
                }
            } else {
                LabeledContent("Название", value: org.name)
            }
            LabeledContent("Ваша роль", value: org.brief.roleTitle)
            LabeledContent("План", value: planText(org))
        } footer: {
            if org.plan != "enterprise" {
                Text("Enterprise для организаций: общий пул часов, приглашения без ограничений, приватные шаблоны, оплата по счёту — напишите на support@lakonik.app.")
            }
        }
    }

    private func planText(_ org: Organization) -> String {
        guard org.plan == "enterprise" else { return "Free" }
        var s = "Enterprise"
        if let seats = org.planSeats { s += " · \(org.membersCount)/\(seats) мест" }
        if let until = org.planUntil { s += " · до \(until.formatted(.dateTime.day().month(.abbreviated).year().locale(Locale(identifier: "ru_RU"))))" }
        return s
    }

    @ViewBuilder private func inviteSection(_ org: Organization) -> some View {
        if org.isAdmin {
            Section {
                if let link = org.inviteLink, let url = URL(string: link) {
                    ShareLink(item: url, subject: Text("Приглашение в \(org.name)"), message: Text("Присоединяйтесь к «\(org.name)» в Lakonik: \(link)")) {
                        Label("Поделиться ссылкой-приглашением", systemImage: "square.and.arrow.up")
                    }
                    Button { confirmRotate = true } label: { Label("Перевыпустить ссылку", systemImage: "arrow.triangle.2.circlepath") }.foregroundStyle(.secondary)
                }
                HStack {
                    TextField("Почта коллеги", text: $inviteEmail).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("", selection: $inviteRole) { Text("Участник").tag("member"); Text("Админ").tag("admin") }.labelsHidden().fixedSize()
                    Button { Task { await invite() } } label: { Image(systemName: "paperplane.fill") }
                        .disabled(busy || !inviteEmail.contains("@"))
                }
            } header: {
                Text("Пригласить")
            } footer: {
                Text("Ссылка работает для всех, кому вы её отправите; письмо — только для указанной почты. Приглашения действуют 14 дней.")
            }
        }
    }

    @ViewBuilder private func membersSection(_ org: Organization) -> some View {
        Section("Участники · \(org.membersCount)") {
            ForEach(org.members) { m in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name.isEmpty ? m.email : m.name).font(.subheadline)
                        Text(m.email).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(m.roleTitle).font(.caption).foregroundStyle(m.role == "owner" ? .orange : .secondary)
                }
                .contextMenu { if org.isAdmin, m.userId != myId, m.role != "owner" { memberActions(org, m) } }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if org.isAdmin, m.userId != myId, m.role != "owner", org.isOwner || m.role != "admin" {
                        Button(role: .destructive) { removing = m } label: { Label("Удалить", systemImage: "person.badge.minus") }
                    }
                }
            }
        }
    }

    @ViewBuilder private func memberActions(_ org: Organization, _ m: OrgMember) -> some View {
        if m.role == "member" { Button { Task { await setRole(m, "admin") } } label: { Label("Сделать администратором", systemImage: "person.badge.key") } }
        if m.role == "admin" { Button { Task { await setRole(m, "member") } } label: { Label("Сделать участником", systemImage: "person") } }
        if org.isOwner { Button { transferTarget = m } label: { Label("Передать владение", systemImage: "crown") } }
        if org.isOwner || m.role != "admin" { Button(role: .destructive) { removing = m } label: { Label("Удалить из организации", systemImage: "person.badge.minus") } }
    }

    @ViewBuilder private func pendingSection(_ org: Organization) -> some View {
        Section("Ожидают приглашения") {
            ForEach(org.pendingInvitations) { p in
                HStack {
                    Text(p.email).font(.subheadline)
                    Spacer()
                    Text("до \(p.expiresAt.formatted(.dateTime.day().month(.abbreviated).locale(Locale(identifier: "ru_RU"))))").font(.caption).foregroundStyle(.secondary)
                }
                .swipeActions { Button(role: .destructive) { Task { await revoke(p) } } label: { Label("Отозвать", systemImage: "xmark") } }
            }
        }
    }

    @ViewBuilder private func domainsSection(_ org: Organization) -> some View {
        Section {
            ForEach(org.domains, id: \.domain) { d in
                HStack {
                    Text("@\(d.domain)")
                    Spacer()
                    Image(systemName: d.verified ? "checkmark.seal.fill" : "clock").foregroundStyle(d.verified ? .green : .secondary)
                }
            }
            if org.domains.isEmpty { Text("Домен корпоративной почты появится, когда организацию создаст сотрудник с такой почтой").font(.footnote).foregroundStyle(.secondary) }
            if org.isAdmin, !org.domains.isEmpty {
                Toggle("Сотрудники с этой почтой вступают сами", isOn: Binding(get: { org.allowDomainJoin }, set: { v in Task { await patch(PatchOrgBody(allowDomainJoin: v)) } }))
            }
        } header: {
            Text("Домены почты")
        } footer: {
            if org.allowDomainJoin { Text("Новый сотрудник с почтой на подтверждённом домене увидит организацию при первом входе и сможет вступить без приглашения.") }
        }
    }

    @ViewBuilder private func keytermsSection(_ org: Organization) -> some View {
        Section {
            TextField("Бренды, имена, термины — через запятую", text: $keytermsText, axis: .vertical).lineLimit(2...6)
                .onSubmit { Task { await saveKeyterms() } }
            if keytermsText != org.keyterms.joined(separator: ", ") {
                Button("Сохранить словарь") { Task { await saveKeyterms() } }
            }
        } header: {
            Text("Словарь для расшифровки")
        } footer: {
            Text("Названия клиентов, продуктов и имена, которые распознавание должно писать правильно. Подставляются в каждую расшифровку организации.")
        }
    }

    @ViewBuilder private func dangerSection(_ org: Organization) -> some View {
        Section {
            if org.isOwner {
                Button("Удалить организацию", role: .destructive) { confirmDelete = true }
            } else {
                Button("Покинуть организацию", role: .destructive) { confirmLeave = true }
            }
        } footer: {
            if org.isOwner { Text("Чтобы уйти, сначала передайте владение другому участнику (долгое нажатие на участнике).") }
        }
    }

    // MARK: Действия

    private func load() async {
        do {
            let o = try await APIClient.shared.organization(orgId)
            org = o
            editingName = o.name
            keytermsText = o.keyterms.joined(separator: ", ")
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func run(_ op: () async throws -> Void) async {
        busy = true; error = nil
        defer { busy = false }
        do { try await op(); await load() } catch { self.error = error.localizedDescription }
    }

    private func patch(_ body: PatchOrgBody) async { await run { org = try await APIClient.shared.updateOrganization(orgId, body); await auth.refreshMe() } }
    private func invite() async { await run { try await APIClient.shared.invite(orgId, email: inviteEmail.trimmingCharacters(in: .whitespaces), role: inviteRole); inviteEmail = "" } }
    private func revoke(_ p: PendingInvitation) async { await run { try await APIClient.shared.revokeInvitation(orgId, invitationId: p.id) } }
    private func setRole(_ m: OrgMember, _ role: String) async { await run { try await APIClient.shared.setMemberRole(orgId, userId: m.userId, role: role) } }
    private func remove(_ m: OrgMember, transferTo: String?) async { await run { try await APIClient.shared.removeMember(orgId, userId: m.userId, transferTo: transferTo); NotificationCenter.default.post(name: .meetingsChanged, object: nil) } }
    private func transfer(to m: OrgMember) async { await run { org = try await APIClient.shared.transferOwnership(orgId, to: m.userId); await auth.refreshMe() } }
    private func rotate() async { await run { _ = try await APIClient.shared.rotateInviteLink(orgId) } }
    private func saveKeyterms() async {
        let terms = keytermsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        await patch(PatchOrgBody(keyterms: terms))
    }
    private func leave() async {
        busy = true; defer { busy = false }
        do {
            try await APIClient.shared.leaveOrganization(orgId)
            await auth.refreshMe()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
    private func deleteOrg() async {
        busy = true; defer { busy = false }
        do {
            try await APIClient.shared.deleteOrganization(orgId)
            await auth.refreshMe()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
