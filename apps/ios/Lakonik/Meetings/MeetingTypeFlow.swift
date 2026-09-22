import SwiftUI

/// Выбор типа встречи и контекста для уже существующей записи. Запись всегда стартует без типа;
/// тип задаётся с экрана записи (пока идёт встреча) или после расшифровки — на шаге «спикеры → тип → отчёт».
struct MeetingTypeSheet: View {
    @Environment(TemplateStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let meetingId: String
    var initial: MeetingDetail? = nil
    var actionTitle: String = "Сохранить"
    let onDone: (MeetingTemplate, MeetingDetail) -> Void

    var body: some View {
        NavigationStack {
            GroupPickerView()
                .meetingTypeDestinations(meetingId: meetingId, initial: initial, actionTitle: actionTitle) { t, d in
                    onDone(t, d)
                    dismiss()
                }
                .navigationTitle("С кем встреча?")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
        }
        .task { await store.refresh() }
    }
}

/// Назначения навигации выбора типа: группа → шаблон → контекст. Объявлять на корневом экране NavigationStack
/// (внутри уже открытого экрана SwiftUI их не регистрирует).
struct MeetingTypeDestinations: ViewModifier {
    let meetingId: String
    var initial: MeetingDetail?
    var actionTitle: String
    let onDone: (MeetingTemplate, MeetingDetail) -> Void

    func body(content: Content) -> some View {
        content
            .navigationDestination(for: TemplateGroup.self) { g in TemplatePickerView(group: g) }
            .navigationDestination(for: MeetingTemplate.self) { t in ContextFormView(template: t, meetingId: meetingId, initial: initial, actionTitle: actionTitle, onDone: onDone) }
    }
}

extension View {
    func meetingTypeDestinations(meetingId: String, initial: MeetingDetail? = nil, actionTitle: String = "Сохранить", onDone: @escaping (MeetingTemplate, MeetingDetail) -> Void) -> some View {
        modifier(MeetingTypeDestinations(meetingId: meetingId, initial: initial, actionTitle: actionTitle, onDone: onDone))
    }
}

struct GroupPickerView: View {
    @Environment(TemplateStore.self) private var store

    var body: some View {
        List {
            if !store.recentCodes.isEmpty {
                Section("Недавние") {
                    ForEach(store.recentCodes, id: \.self) { code in
                        if let t = store.templates.first(where: { $0.code == code }) {
                            NavigationLink(value: t) { TemplateRow(template: t, compact: true) }
                        }
                    }
                }
            }
            Section {
                ForEach(store.groups) { g in
                    NavigationLink(value: g) {
                        HStack(spacing: 14) {
                            Text(g.emoji).font(.title)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.title).font(.headline)
                                Text(g.subtitle).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(store.templates(in: g.code).count)").font(.caption).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6)
                    }
                }
            } header: {
                Text("Тип встречи")
            } footer: {
                if store.templates.isEmpty {
                    Text(store.lastError.map { "Не удалось загрузить шаблоны: \($0)" } ?? "Загрузка шаблонов…")
                } else {
                    Text("Тип встречи определяет структуру отчёта.")
                }
            }
        }
    }
}

struct TemplatePickerView: View {
    @Environment(TemplateStore.self) private var store
    let group: TemplateGroup

    var body: some View {
        List {
            ForEach(store.templates(in: group.code)) { t in
                NavigationLink(value: t) { TemplateRow(template: t, compact: false) }
            }
        }
        .navigationTitle(group.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct TemplateRow: View {
    let template: MeetingTemplate
    let compact: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(template.emoji).font(compact ? .title3 : .title2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(template.title).font(.headline)
                    if template.isRestricted { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                    if template.isDraft { Text("черновик").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2).background(Color.orange.opacity(0.15), in: Capsule()).foregroundStyle(.orange) }
                }
                if let s = template.subtitle, !compact { Text(s).font(.subheadline).foregroundStyle(.secondary) }
                if !compact { Text(template.goal).font(.caption).foregroundStyle(.tertiary).lineLimit(2) }
            }
        }
        .padding(.vertical, compact ? 2 : 6)
    }
}

struct LabeledField: View {
    let field: TemplateField
    @Binding var text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(field.label).font(.caption).foregroundStyle(.secondary)
            TextField(field.hint ?? "", text: $text, axis: .vertical)
        }
        .padding(.vertical, 2)
    }
}

/// Контекст встречи: ключевые поля шаблона (askBeforeRecording), участники, число спикеров, платформа.
/// Сохраняет тип и контекст в существующую встречу (PATCH) и отдаёт результат наверх.
@MainActor
struct ContextFormView: View {
    @Environment(TemplateStore.self) private var store
    let template: MeetingTemplate
    let meetingId: String
    var initial: MeetingDetail? = nil
    var actionTitle: String = "Сохранить"
    let onDone: (MeetingTemplate, MeetingDetail) -> Void

    @State private var values: [String: String] = [:]
    @State private var participants: [Participant] = []
    @State private var newParticipant = ""
    @State private var numSpeakers = 0
    @State private var platform = ""
    @State private var restricted = false
    @State private var language = "auto"
    @State private var showAllFields = false
    @State private var busy = false
    @State private var error: String?
    @State private var prefilled = false

    private var keyFields: [TemplateField] { template.specificFields.filter { $0.askBeforeRecording == true } }
    private var otherFields: [TemplateField] { template.specificFields.filter { $0.askBeforeRecording != true } }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Text(template.emoji).font(.largeTitle)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(template.title).font(.headline)
                        Text(template.goal).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section {
                ForEach(keyFields) { f in LabeledField(field: f, text: binding(f.key)) }
                if !otherFields.isEmpty {
                    DisclosureGroup("Ещё поля (\(otherFields.count))", isExpanded: $showAllFields) {
                        ForEach(otherFields) { f in LabeledField(field: f, text: binding(f.key)) }
                    }
                }
            } header: {
                Text("Контекст встречи")
            } footer: {
                Text("Всё необязательно: то, чего нет, AI извлечёт из записи, а не найденное отметит как «не озвучено, уточнить».")
            }

            Section("Участники") {
                ForEach(participants) { p in
                    Text([p.name, p.role, p.company].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                }
                .onDelete { participants.remove(atOffsets: $0) }
                HStack {
                    TextField("Имя · роль · компания", text: $newParticipant)
                        .onSubmit(addParticipant)
                    Button(action: addParticipant) { Image(systemName: "plus.circle.fill") }.disabled(newParticipant.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Stepper(numSpeakers == 0 ? "Число говорящих: авто" : "Число говорящих: \(numSpeakers)", value: $numSpeakers, in: 0...12)
            }

            Section("Детали") {
                TextField("Место / платформа (офис, Zoom, Teams)", text: $platform)
                Picker("Язык записи", selection: $language) {
                    Text("Авто (RU / KK / EN)").tag("auto")
                    Text("Русский").tag("ru")
                    Text("Қазақша").tag("kk")
                    Text("English").tag("en")
                }
                if template.allowConfidentialityChoice {
                    Toggle("Конфиденциально (только я и те, с кем поделюсь)", isOn: $restricted)
                }
                if template.isRestricted {
                    Label("Конфиденциальная встреча: отчёт видите только вы и те, с кем поделитесь", systemImage: "lock.fill").font(.footnote).foregroundStyle(.secondary)
                }
            }

            if !template.tips.isEmpty {
                Section("Советы для этого типа встречи") {
                    ForEach(template.tips, id: \.self) { tip in
                        Label(tip, systemImage: "lightbulb").font(.footnote)
                    }
                }
            }

            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Контекст встречи")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: prefill)
        .safeAreaInset(edge: .bottom) {
            Button { Task { await apply() } } label: {
                HStack {
                    if busy { ProgressView().tint(.white) } else { Image(systemName: "checkmark.circle") }
                    Text(actionTitle).font(.headline)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            .padding(16)
            .background(.bar)
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })
    }

    /// Предзаполнение из встречи: контекст мог вводиться раньше (например, во время записи)
    private func prefill() {
        guard !prefilled, let d = initial else { return }
        prefilled = true
        for (k, v) in d.visibleContextFields {
            switch v {
            case .string(let s): values[k] = s
            case .number(let n): values[k] = n.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(n)) : String(n)
            case .list(let l): if k != "participants" { values[k] = l.joined(separator: ", ") }
            case .null: break
            }
        }
        participants = d.participantsHint
        numSpeakers = d.numSpeakersHint ?? 0
        platform = d.platform ?? ""
        language = d.languageHint ?? "auto"
        restricted = d.confidentiality == "restricted"
    }

    private func addParticipant() {
        let parts = newParticipant.split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let name = parts.first, !name.isEmpty else { return }
        participants.append(Participant(name: name, role: parts.count > 1 ? parts[1] : nil, company: parts.count > 2 ? parts[2] : nil, side: nil))
        newParticipant = ""
    }

    private func apply() async {
        busy = true; error = nil
        defer { busy = false }
        var ctx: [String: ContextValue] = [:]
        for (k, v) in values where !v.trimmingCharacters(in: .whitespaces).isEmpty { ctx[k] = .string(v.trimmingCharacters(in: .whitespaces)) }
        if !participants.isEmpty { ctx["participants"] = .list(participants.map { [$0.name, $0.role, $0.company].compactMap { $0 }.joined(separator: " · ") }) }
        if !platform.isEmpty { ctx["platform"] = .string(platform) }
        var body = UpdateMeetingBody(templateId: template.id, contextFields: ctx, participantsHint: participants, platform: platform.isEmpty ? nil : platform)
        body.numSpeakersHint = numSpeakers > 0 ? numSpeakers : nil
        body.languageHint = language == "auto" ? nil : language
        if template.allowConfidentialityChoice { body.confidentiality = restricted ? "restricted" : "standard" }
        do {
            let detail = try await APIClient.shared.updateMeeting(meetingId, body)
            store.markUsed(template)
            onDone(template, detail)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
