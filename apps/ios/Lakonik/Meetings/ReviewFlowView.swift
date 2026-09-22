import SwiftUI

/// Премодерация после расшифровки: подтвердить спикеров (имена, стороны, «это я», слияние дублей диаризации)
/// → выбрать тип встречи и контекст → сформировать отчёт. Спикеров можно сохранить и без отчёта.
@MainActor
struct ReviewFlowView: View {
    @Environment(\.dismiss) private var dismiss
    let detail: MeetingDetail
    /// Отчёт поставлен в очередь — экран встречи начинает следить за статусом
    let onGenerated: () -> Void
    @State private var path = NavigationPath()

    private enum Route: Hashable { case type }

    var body: some View {
        // Единый value-based стек: спикеры → (Route.type) группы → шаблон → контекст
        NavigationStack(path: $path) {
            SpeakersReviewStep(detail: detail, onSavedWithoutReport: { dismiss() }, onNext: { path.append(Route.type) })
                .navigationDestination(for: Route.self) { _ in GroupPickerView().navigationTitle("Тип встречи").navigationBarTitleDisplayMode(.inline) }
                .meetingTypeDestinations(meetingId: detail.id, initial: detail, actionTitle: "Сформировать отчёт") { t, _ in Task { await generate(template: t) } }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } } }
        }
        .interactiveDismissDisabled()
    }

    private func generate(template: MeetingTemplate) async {
        _ = try? await APIClient.shared.regenerate(meetingId: detail.id, body: RegenerateBody(templateId: template.id))
        onGenerated()
        dismiss()
    }
}

/// Черновик решения по спикеру
struct SpeakerDraft: Identifiable {
    let id: String
    var name: String
    var side: SpeakerRole?
    /// id спикера, с которым объединяем (дубль диаризации)
    var mergeInto: String?
    let sample: String
    let count: Int
    let suggestion: SpeakerSuggestion?
    /// Подсказка ИИ ещё не применена (показываем кнопку «Применить»)
    var suggestionPending: Bool
}

@MainActor
struct SpeakersReviewStep: View {
    @Environment(AuthService.self) private var auth
    let detail: MeetingDetail
    let onSavedWithoutReport: () -> Void
    let onNext: () -> Void

    @State private var drafts: [SpeakerDraft] = []
    @State private var selfId: String?
    @State private var busy = false
    @State private var error: String?
    @State private var prepared = false

    private var transcript: Transcript? { detail.transcript }
    private var suggestions: SpeakerSuggestions? { transcript?.speakerSuggestions }
    private var activeDrafts: [SpeakerDraft] { drafts.filter { $0.mergeInto == nil } }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if let s = suggestions {
                        let diarized = transcript?.speakerIds.count ?? 0
                        Text(diarized > s.estimatedSpeakerCount
                             ? "ИИ насчитал \(s.estimatedSpeakerCount) \(plural(s.estimatedSpeakerCount)), автоматическое разделение выделило \(diarized) — похоже, кого-то разбило на двоих. Проверьте и объедините дубли."
                             : "ИИ насчитал \(s.estimatedSpeakerCount) \(plural(s.estimatedSpeakerCount)). Проверьте имена и стороны — они попадут в отчёт.")
                            .font(.subheadline)
                        if let n = s.notes, !n.isEmpty, s.model != "fake" { Text(n).font(.caption).foregroundStyle(.secondary) }
                    } else {
                        Text("Проверьте, кто есть кто: имена и стороны попадут в отчёт. Дубли автоматического разделения можно объединить.").font(.subheadline)
                    }
                }
                .padding(.vertical, 4)
            }

            ForEach($drafts) { $draft in
                if draft.mergeInto == nil {
                    Section {
                        SpeakerDraftCard(draft: $draft, others: activeDrafts.filter { $0.id != draft.id }, label: label(for:), isSelf: selfId == draft.id, onSelf: { toggleSelf(draft.id) }, myName: auth.me?.name ?? "", participants: detail.participantsHint)
                    } header: {
                        HStack {
                            Text(label(for: draft.id))
                            Spacer()
                            Text("\(draft.count) \(pluralReplica(draft.count))").foregroundStyle(.tertiary)
                        }
                    }
                } else {
                    Section {
                        HStack {
                            Image(systemName: "arrow.triangle.merge").foregroundStyle(.secondary)
                            Text("\(label(for: draft.id)) → объединён с «\(label(for: draft.mergeInto!))»").font(.subheadline).foregroundStyle(.secondary)
                            Spacer()
                            Button("Отменить") { draft.mergeInto = nil }.font(.caption)
                        }
                    }
                }
            }

            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Кто говорил")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: prepare)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                Button { Task { await save(thenNext: true) } } label: {
                    HStack {
                        if busy { ProgressView().tint(.white) } else { Image(systemName: "arrow.right.circle") }
                        Text("Далее: тип встречи и отчёт").font(.headline)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                Button("Сохранить спикеров без отчёта") { Task { await save(thenNext: false) } }
                    .font(.subheadline)
                    .disabled(busy)
            }
            .padding(16)
            .background(.bar)
        }
    }

    private func plural(_ n: Int) -> String { n % 10 == 1 && n % 100 != 11 ? "участника" : "участников" }
    private func pluralReplica(_ n: Int) -> String {
        let m = n % 10, h = n % 100
        if m == 1 && h != 11 { return "реплика" }
        if (2...4).contains(m) && !(12...14).contains(h) { return "реплики" }
        return "реплик"
    }

    /// Подпись спикера: имя из черновика → «Спикер N» по порядку в транскрипте
    private func label(for id: String) -> String {
        if let d = drafts.first(where: { $0.id == id }), !d.name.trimmingCharacters(in: .whitespaces).isEmpty { return d.name }
        return transcript?.label(for: id) ?? id
    }

    /// Черновики: текущие имена/роли из транскрипта, поверх — подсказки ИИ (уверенные подставляем сразу, остальные — кнопкой)
    private func prepare() {
        guard !prepared, let t = transcript else { return }
        prepared = true
        selfId = t.selfSpeakerId
        let counts = Dictionary(grouping: t.segments, by: \.speakerId).mapValues(\.count)
        drafts = t.speakerIds.map { id in
            let sug = t.speakerSuggestions?.suggestion(for: id)
            let existingName = t.speakers[id] ?? ""
            let confident = sug?.confidence == "high" || sug?.confidence == "medium"
            var name = existingName
            var side = t.speakerRoles[id]
            var pending = false
            if existingName.isEmpty, let n = sug?.name, !n.isEmpty {
                if confident { name = n } else { pending = true }
            }
            if side == nil, let r = sug?.sideRole {
                if confident { side = r } else { pending = true }
            }
            let segs = t.segments.filter { $0.speakerId == id }
            let sample = segs.first(where: { $0.text.count >= 25 })?.text ?? segs.first?.text ?? ""
            return SpeakerDraft(id: id, name: name, side: side, mergeInto: sug?.sameAs, sample: String(sample.prefix(180)), count: counts[id] ?? 0, suggestion: sug, suggestionPending: pending)
        }
        // цель слияния не должна сама быть слитой
        for i in drafts.indices {
            if let into = drafts[i].mergeInto, drafts.first(where: { $0.id == into })?.mergeInto != nil { drafts[i].mergeInto = nil }
        }
    }

    private func toggleSelf(_ id: String) {
        if selfId == id { selfId = nil; return }
        selfId = id
        if let i = drafts.firstIndex(where: { $0.id == id }) {
            if drafts[i].name.trimmingCharacters(in: .whitespaces).isEmpty, let my = auth.me?.name, !my.isEmpty { drafts[i].name = my }
            drafts[i].side = .ours
        }
    }

    /// PATCH спикеров: имена, стороны, «это я», слияния; после — либо к выбору типа, либо закрыть
    private func save(thenNext: Bool) async {
        busy = true; error = nil
        defer { busy = false }
        var names: [String: String] = [:]
        var roles: [String: SpeakerRole] = [:]
        var merges: [String: String] = [:]
        for d in drafts {
            if let into = d.mergeInto { merges[d.id] = into; continue }
            let n = d.name.trimmingCharacters(in: .whitespaces)
            if !n.isEmpty { names[d.id] = n }
            if let s = d.side { roles[d.id] = s }
        }
        let resolvedSelf = selfId.flatMap { merges[$0] ?? $0 }
        do {
            _ = try await APIClient.shared.renameSpeakers(meetingId: detail.id, speakers: names, selfSpeakerId: .some(resolvedSelf), speakerRoles: roles, merges: merges.isEmpty ? nil : merges, confirmed: true)
            if thenNext { onNext() } else { onSavedWithoutReport() }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Карточка спикера: пример реплики, имя, сторона, «это я», объединение, подсказка ИИ
struct SpeakerDraftCard: View {
    @Binding var draft: SpeakerDraft
    let others: [SpeakerDraft]
    let label: (String) -> String
    let isSelf: Bool
    let onSelf: () -> Void
    let myName: String
    let participants: [Participant]

    var body: some View {
        if !draft.sample.isEmpty {
            Text("«\(draft.sample)»").font(.footnote).italic().foregroundStyle(.secondary).lineLimit(3)
        }
        HStack {
            TextField("Имя (или оставить «Спикер N»)", text: $draft.name)
            Menu {
                if let n = draft.suggestion?.name, !n.isEmpty { Button("ИИ: \(n)") { draft.name = n } }
                if !myName.isEmpty { Button("Я — \(myName)") { onSelf() } }
                ForEach(participants, id: \.name) { p in Button(p.name) { draft.name = p.name } }
            } label: { Image(systemName: "text.badge.plus") }
            .disabled(draft.suggestion?.name == nil && myName.isEmpty && participants.isEmpty)
        }
        Picker("Сторона", selection: Binding(get: { draft.side?.rawValue ?? "" }, set: { draft.side = SpeakerRole(rawValue: $0) })) {
            Text("не указана").tag("")
            ForEach(SpeakerRole.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
        }
        .pickerStyle(.segmented)
        Button { onSelf() } label: {
            Label(isSelf ? "Это я ✓" : "Это я", systemImage: isSelf ? "person.crop.circle.badge.checkmark" : "person.crop.circle")
                .foregroundStyle(isSelf ? Color.accentColor : Color.primary)
        }
        if !others.isEmpty {
            Menu {
                ForEach(others) { o in Button("→ \(label(o.id))") { draft.mergeInto = o.id } }
            } label: {
                Label("Объединить с другим спикером (дубль)", systemImage: "arrow.triangle.merge").foregroundStyle(.primary)
            }
        }
        if let s = draft.suggestion { suggestionRow(s) }
    }

    @ViewBuilder private func suggestionRow(_ s: SpeakerSuggestion) -> some View {
        let parts = [s.name, s.role, s.company, s.sideRole?.title].compactMap { $0 }.filter { !$0.isEmpty }
        if !parts.isEmpty || s.sameAs != nil {
            VStack(alignment: .leading, spacing: 4) {
                if !parts.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "sparkles").foregroundStyle(.purple)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("ИИ, \(s.confidenceTitle): \(parts.joined(separator: " · "))").font(.caption)
                            if let e = s.evidence, !e.isEmpty { Text(e).font(.caption2).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if draft.suggestionPending {
                            Button("Применить") {
                                if let n = s.name, !n.isEmpty { draft.name = n }
                                if let r = s.sideRole { draft.side = r }
                                draft.suggestionPending = false
                            }
                            .font(.caption).buttonStyle(.bordered).controlSize(.mini)
                        }
                    }
                }
                if let same = s.sameAs, draft.mergeInto == nil {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.merge").foregroundStyle(.purple)
                        Text("Похоже, тот же человек, что «\(label(same))»").font(.caption)
                        Spacer()
                        Button("Объединить") { draft.mergeInto = same }.font(.caption).buttonStyle(.bordered).controlSize(.mini)
                    }
                }
            }
        }
    }
}
