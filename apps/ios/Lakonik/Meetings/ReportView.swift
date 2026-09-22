import SwiftUI

/// Отчёт по разделам шаблона: текст (markdown), таблицы, списки, чек-лист action items.
@MainActor
struct ReportView: View {
    let report: Report
    let meeting: MeetingDetail
    let tasks: [TaskItem]
    let onToggleTask: (TaskItem) async -> Void
    let onEditTask: (TaskItem) -> Void
    let onAddTask: () -> Void
    let onEditReport: () -> Void
    let onAIFix: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(report.reportTitle).font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
                    Text(report.title).font(.title3.bold())
                    HStack(spacing: 8) {
                        Text(Fmt.dateTime.string(from: meeting.startedAt))
                        if let d = meeting.durationSec { Text("· \(Fmt.duration(d))") }
                        if meeting.confidentiality == "restricted" { Label("Конфиденциально", systemImage: "lock.fill") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        if report.version > 1 { Text("Версия \(report.version) · \(report.createdBy == "regenerate" ? "пересобран" : "авто")").font(.caption2).foregroundStyle(.tertiary) }
                        if let e = report.editedAt { Label("Отредактирован \(Fmt.dateTime.string(from: e))", systemImage: "pencil").font(.caption2).foregroundStyle(.tertiary) }
                    }
                    if meeting.isOwner {
                        HStack(spacing: 8) {
                            Button { onAIFix() } label: { Label("Исправить с ИИ", systemImage: "wand.and.stars").font(.subheadline) }
                                .buttonStyle(.borderedProminent).controlSize(.small)
                            Button { onEditReport() } label: { Label("Править текст", systemImage: "pencil.line").font(.subheadline) }
                                .buttonStyle(.bordered).controlSize(.small)
                        }
                        .padding(.top, 4)
                    }
                }

                ForEach(Array(report.sections.enumerated()), id: \.element.key) { i, s in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Text("\(i + 1). \(s.heading)").font(.headline)
                            if s.internalOnly { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.orange) }
                        }
                        if s.internalOnly { Text("Внутренний блок — не для клиента").font(.caption).foregroundStyle(.orange) }
                        sectionBody(s)
                    }
                }

                if !report.missingInfo.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Не озвучено — уточнить", systemImage: "questionmark.circle").font(.headline).foregroundStyle(.orange)
                        ForEach(report.missingInfo, id: \.self) { Text("• \($0)").font(.subheadline) }
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }

                Text("Сформировано автоматически по аудиозаписи. Проверьте факты и action items перед отправкой.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(16)
        }
    }

    @ViewBuilder private func sectionBody(_ s: RenderedSection) -> some View {
        switch s.kind {
        case "action_plan":
            if tasks.isEmpty { Text("не озвучено, уточнить").foregroundStyle(.secondary).font(.subheadline) }
            ForEach(tasks) { t in
                TaskRow(task: t, showMeeting: false) { Task { await onToggleTask(t) } }
                    .onTapGesture { if t.isOwner { onEditTask(t) } }
                if let q = t.quote, !q.isEmpty { Text("«\(q)»").font(.caption).italic().foregroundStyle(.tertiary).padding(.leading, 32) }
            }
            if meeting.isOwner {
                Button { onAddTask() } label: { Label("Добавить задачу", systemImage: "plus.circle") }.font(.subheadline).padding(.top, 4)
            }
        case "decisions", "participants", "open_questions", "client_requests", "next_meeting":
            if let t = s.table, !t.rows.isEmpty {
                SimpleTable(table: t)
            } else if let list = s.items, !list.isEmpty {
                ForEach(list, id: \.self) { Text("• \($0)").font(.subheadline) }
            } else {
                Text(s.content).font(.subheadline).foregroundStyle(.secondary)
            }
        default:
            MarkdownText(s.content)
        }
    }
}

/// Markdown-текст с поддержкой таблиц (| a | b |) и списков
struct MarkdownText: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .table(let t): SimpleTable(table: t)
                case .text(let s):
                    Text((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s))
                        .font(.subheadline)
                }
            }
        }
    }

    private enum Block { case text(String); case table(RenderedTable) }

    private var blocks: [Block] {
        var out: [Block] = []
        var buf: [String] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0
        func flush() { if !buf.isEmpty { out.append(.text(buf.joined(separator: "\n"))); buf = [] } }
        while i < lines.count {
            let l = lines[i]
            if l.trimmingCharacters(in: .whitespaces).hasPrefix("|"), i + 1 < lines.count, lines[i + 1].contains("---") {
                flush()
                let cols = split(l)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(split(lines[i])); i += 1 }
                out.append(.table(RenderedTable(columns: cols, rows: rows)))
                continue
            }
            buf.append(l.replacingOccurrences(of: "^\\s*[-*]\\s+", with: "• ", options: .regularExpression))
            i += 1
        }
        flush()
        return out
    }

    private func split(_ l: String) -> [String] {
        var s = l.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

struct SimpleTable: View {
    let table: RenderedTable
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(table.rows.enumerated()), id: \.offset) { ri, row in
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(table.columns.enumerated()), id: \.offset) { ci, col in
                        if ci == 0 {
                            Text(row.indices.contains(ci) ? row[ci] : "").font(.subheadline.weight(.medium))
                        } else {
                            HStack(alignment: .top, spacing: 4) {
                                Text(col + ":").font(.caption).foregroundStyle(.secondary)
                                Text(row.indices.contains(ci) ? row[ci] : "—").font(.caption)
                            }
                        }
                    }
                }
                .padding(.vertical, 8)
                if ri < table.rows.count - 1 { Divider() }
            }
        }
        .padding(.horizontal, 12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct MeetingInfoView: View {
    let detail: MeetingDetail
    let template: MeetingTemplate?
    var body: some View {
        List {
            Section("Встреча") {
                LabeledContent("Тип", value: "\(detail.templateEmoji) \(detail.templateTitle)")
                LabeledContent("Начало", value: Fmt.dateTime.string(from: detail.startedAt))
                LabeledContent("Длительность", value: Fmt.duration(detail.durationSec))
                if let p = detail.platform, !p.isEmpty { LabeledContent("Платформа", value: p) }
                LabeledContent("Сегментов аудио", value: "\(detail.segmentCount)")
                LabeledContent("Отчёт отправить до") {
                    Text(Fmt.dateTime.string(from: detail.reportDueAt))
                        .foregroundStyle(detail.reportDueAt < Date() && detail.status == .done ? .red : .primary)
                }
                Text("Срок отчёта: \(detail.reportSlaHours) ч после встречи (настраивается в Настройках → Сроки)").font(.caption).foregroundStyle(.secondary)
                LabeledContent("Конфиденциальность", value: detail.confidentiality == "restricted" ? "Ограниченная" : "Стандартная")
            }
            if !detail.visibleContextFields.isEmpty {
                Section("Контекст, введённый перед записью") {
                    ForEach(detail.visibleContextFields.keys.sorted(), id: \.self) { k in
                        let label = (template?.specificFields.first { $0.key == k }?.label) ?? (template?.commonFields.first { $0.key == k }?.label) ?? k
                        LabeledContent(label, value: detail.contextFields[k]?.displayText ?? "")
                    }
                }
            }
            if !detail.markers.isEmpty {
                Section("Отметки во время записи") {
                    ForEach(detail.markers) { m in
                        HStack { Text(Fmt.clock(m.atSec)).monospacedDigit().foregroundStyle(.secondary); Text(m.note ?? "важный момент") }
                    }
                }
            }
            if detail.reportVersions.count > 1 {
                Section("Версии отчёта") {
                    ForEach(detail.reportVersions) { v in
                        VStack(alignment: .leading, spacing: 2) {
                            LabeledContent("v\(v.version) · \(v.createdBy == "regenerate" ? "пересборка" : "авто")", value: Fmt.dateTime.string(from: v.createdAt))
                            if let i = v.instructions, !i.isEmpty { Text("Правки: \(i)").font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                        }
                    }
                }
            }
            if let t = template, let s = t.sendTo {
                Section("Куда отправить") { Text(s) }
            }
        }
    }
}

@MainActor
struct RegenerateSheet: View {
    let detail: MeetingDetail
    let onDone: () async -> Void
    @Environment(TemplateStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var templateId: String
    @State private var draft = false
    @State private var instructions = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    init(detail: MeetingDetail, onDone: @escaping () async -> Void) {
        self.detail = detail
        self.onDone = onDone
        _templateId = State(initialValue: detail.templateId)
    }

    /// Подсказка: короткая подпись чипса и текст, который вставляется в поле (с местом для ответа).
    struct Suggestion: Identifiable, Hashable {
        let id: String
        let label: String
        let text: String
    }

    /// Подсказки формируются из контекста записи: неназванные спикеры, «не озвучено», задачи без ответственного/срока, открытые вопросы.
    private var suggestions: [Suggestion] {
        var out: [Suggestion] = []
        if let tr = detail.transcript {
            for id in tr.speakerIds where (tr.speakers[id] ?? "").isEmpty {
                let label = tr.label(for: id)
                out.append(Suggestion(id: "spk-\(id)", label: "\(label) — это…", text: "\(label) — это "))
            }
        }
        if let r = detail.report {
            for (i, m) in r.missingInfo.prefix(6).enumerated() {
                let short = m.count > 42 ? String(m.prefix(40)) + "…" : m
                out.append(Suggestion(id: "miss-\(i)", label: "Уточнить: \(short)", text: "\(m): "))
            }
            for (i, q) in r.openQuestions.prefix(4).enumerated() {
                let short = q.count > 42 ? String(q.prefix(40)) + "…" : q
                out.append(Suggestion(id: "q-\(i)", label: "Ответ: \(short)", text: "Ответ на вопрос «\(q)»: "))
            }
        }
        for t in detail.tasks.prefix(12) where !t.isDone {
            let short = t.task.count > 36 ? String(t.task.prefix(34)) + "…" : t.task
            if t.assigneeName == nil || (t.assigneeName?.hasPrefix("Спикер") ?? false) {
                out.append(Suggestion(id: "asg-\(t.id)", label: "Ответственный: \(short)", text: "Ответственный за задачу «\(t.task)» — "))
            }
            if t.deadlineDate == nil || t.deadlineIsDefault {
                out.append(Suggestion(id: "dl-\(t.id)", label: "Срок: \(short)", text: "Срок задачи «\(t.task)» — "))
            }
        }
        if out.isEmpty {
            out = [
                Suggestion(id: "g1", label: "Уточнить бюджет", text: "Бюджет: "),
                Suggestion(id: "g2", label: "Убрать раздел…", text: "Убери из отчёта "),
                Suggestion(id: "g3", label: "Добавить задачу…", text: "Добавь в action plan: "),
            ]
        }
        return Array(out.prefix(14))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $instructions)
                        .frame(minHeight: 110)
                        .focused($focused)
                        .overlay(alignment: .topLeading) {
                            if instructions.isEmpty {
                                Text("Например: «Спикер 2 — это Данияр, бренд-менеджер клиента. Бюджет 40 млн — это медиа, продакшн отдельно. Убери пункт про наружку в Астане.»")
                                    .foregroundStyle(.tertiary).font(.subheadline).padding(.top, 8).padding(.leading, 4).allowsHitTesting(false)
                            }
                        }
                } header: {
                    Text("Что исправить в отчёте")
                } footer: {
                    Text("Пусто — отчёт просто пересоберётся по выбранному шаблону. С текстом — ИИ возьмёт транскрипт и текущую версию и внесёт правки, сохранив остальное. Прежняя версия остаётся в истории (вкладка «Инфо»).")
                }
                Section {
                    FlowLayout(spacing: 6) {
                        ForEach(suggestions) { sg in
                            Button {
                                let sep = instructions.isEmpty || instructions.hasSuffix("\n") ? "" : "\n"
                                instructions += sep + sg.text
                                focused = true
                            } label: {
                                Text(sg.label).font(.caption).lineLimit(1)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 2)
                } header: {
                    Text("Подсказки по этой записи")
                } footer: {
                    Text("Нажмите подсказку — она вставится в поле, допишите ответ.")
                }
                Section("Шаблон отчёта") {
                    Picker("Тип встречи", selection: $templateId) {
                        ForEach(store.templates) { t in Text("\(t.emoji) \(t.title)").tag(t.id) }
                    }
                }
                Section {
                    Toggle("Быстрый черновик (дешевле, чуть проще)", isOn: $draft)
                } footer: {
                    Text("Аудио заново не нужно — используется готовый транскрипт. Заданные имена и роли спикеров попадут в отчёт.")
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Правка с ИИ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Пересобрать" : "Исправить") { Task { await run() } }.disabled(busy)
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Готово") { focused = false } }
            }
        }
    }

    private func run() async {
        busy = true; defer { busy = false }
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await APIClient.shared.regenerate(meetingId: detail.id, body: RegenerateBody(templateId: templateId == detail.templateId ? nil : templateId, effort: nil, draft: draft ? true : nil, instructions: text.isEmpty ? nil : text))
            dismiss()
            await onDone()
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
struct SharesSheet: View {
    let meetingId: String
    @Environment(\.dismiss) private var dismiss
    @State private var shares: [Share] = []
    @State private var email = ""
    @State private var withTranscript = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Добавить коллегу") {
                    NavigationLink {
                        UserPickerView(exclude: Set(shares.map(\.recipientEmail))) { u in email = u.email; Task { await add() } }
                    } label: { Label("Выбрать из коллег", systemImage: "person.2.badge.plus") }
                    TextField("Или почта вручную", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Вместе с транскриптом", isOn: $withTranscript)
                    Button("Поделиться") { Task { await add() } }.disabled(!email.contains("@"))
                }
                Section("Доступ есть у") {
                    if shares.isEmpty { Text("Пока ни у кого").foregroundStyle(.secondary) }
                    ForEach(shares) { s in
                        HStack { Text(s.recipientEmail); Spacer(); Text(s.scope == "report" ? "отчёт" : "отчёт + транскрипт").font(.caption).foregroundStyle(.secondary) }
                    }
                    .onDelete { idx in Task { for i in idx { try? await APIClient.shared.unshare(meetingId: meetingId, shareId: shares[i].id) }; await load() } }
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .navigationTitle("Поделиться")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
            .task { await load() }
        }
    }

    private func load() async { shares = (try? await APIClient.shared.shares(meetingId: meetingId)) ?? [] }
    private func add() async {
        do { _ = try await APIClient.shared.share(meetingId: meetingId, email: email, scope: withTranscript ? "report_transcript" : "report"); email = ""; await load() } catch { self.error = error.localizedDescription }
    }
}


/// Выбор коллеги из аккаунтов (имя, фамилия, почта, агентство)
@MainActor
struct UserPickerView: View {
    var exclude: Set<String> = []
    let onSelect: (AccountUser) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth
    @State private var users: [AccountUser] = []
    @State private var query = ""

    var body: some View {
        List {
            ForEach(filtered) { u in
                Button { onSelect(u); dismiss() } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(u.displayName).foregroundStyle(.primary)
                        Text([u.email, u.agencyName].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if filtered.isEmpty { Text("Никого не найдено").foregroundStyle(.secondary) }
        }
        .navigationTitle("Коллеги")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Имя или почта")
        .task { users = (try? await APIClient.shared.users()) ?? [] }
    }

    private var filtered: [AccountUser] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return users.filter { u in
            u.id != auth.me?.id && !exclude.contains(u.email) && (q.isEmpty || u.name.lowercased().contains(q) || u.email.lowercased().contains(q))
        }
    }
}
