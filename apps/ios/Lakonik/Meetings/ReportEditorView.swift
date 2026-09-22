import SwiftUI

/// Редактирование текста отчёта перед экспортом: заголовок, резюме, текстовые разделы, участники, решения, списки.
/// Action plan редактируется через задачи (вкладка «Задачи» / раздел отчёта).
@MainActor
struct ReportEditorView: View {
    let meetingId: String
    let report: Report
    let onSaved: () async -> Void
    /// После сохранения сразу открыть экспорт в этом формате
    var exportAfterSave: ((String) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var summaryText: String
    @State private var sections: [(key: String, heading: String, internalOnly: Bool, text: String)]
    @State private var participantsText: String
    @State private var decisionsText: String
    @State private var openQuestionsText: String
    @State private var clientRequestsText: String
    @State private var missingInfoText: String
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDiscard = false
    @FocusState private var focused: String?

    private let hasDecisions: Bool
    private let hasOpenQuestions: Bool
    private let hasClientRequests: Bool

    init(meetingId: String, report: Report, onSaved: @escaping () async -> Void, exportAfterSave: ((String) -> Void)? = nil) {
        self.meetingId = meetingId
        self.report = report
        self.onSaved = onSaved
        self.exportAfterSave = exportAfterSave
        _title = State(initialValue: report.title)
        _summaryText = State(initialValue: report.sections.first { $0.key == "summary" }?.content ?? report.summary)
        let textSections = report.sections.filter { $0.kind == "text" && $0.key != "summary" }
        _sections = State(initialValue: textSections.map { ($0.key, $0.heading, $0.internalOnly, $0.content) })
        _participantsText = State(initialValue: report.participants.map { [$0.name, $0.role, $0.company].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }.joined(separator: "\n"))
        _decisionsText = State(initialValue: report.decisions.map { [$0.decision, $0.owner ?? "", $0.deadline ?? ""].joined(separator: " | ") }.joined(separator: "\n"))
        _openQuestionsText = State(initialValue: report.openQuestions.joined(separator: "\n"))
        _clientRequestsText = State(initialValue: report.clientRequests.joined(separator: "\n"))
        _missingInfoText = State(initialValue: report.missingInfo.joined(separator: "\n"))
        hasDecisions = report.sections.contains { $0.kind == "decisions" }
        hasOpenQuestions = report.sections.contains { $0.kind == "open_questions" }
        hasClientRequests = report.sections.contains { $0.kind == "client_requests" }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Заголовок") {
                    TextField("Заголовок отчёта", text: $title, axis: .vertical).lineLimit(1...3)
                }
                Section {
                    editor($summaryText, id: "summary", minHeight: 100)
                } header: {
                    Text(report.sections.first { $0.key == "summary" }?.heading ?? "Резюме")
                }
                ForEach(sections.indices, id: \.self) { i in
                    Section {
                        editor(Binding(get: { sections[i].text }, set: { sections[i].text = $0 }), id: sections[i].key, minHeight: 120)
                    } header: {
                        HStack {
                            Text(sections[i].heading)
                            if sections[i].internalOnly { Image(systemName: "lock.fill").foregroundStyle(.orange) }
                        }
                    } footer: {
                        if i == 0 { Text("Поддерживается разметка: **жирный**, списки через «- », таблицы «| a | b |».") }
                    }
                }
                Section {
                    editor($participantsText, id: "participants", minHeight: 80)
                } header: { Text("Участники") } footer: { Text("По одному в строке: Имя · роль · компания") }
                if hasDecisions {
                    Section {
                        editor($decisionsText, id: "decisions", minHeight: 80)
                    } header: { Text("Решения") } footer: { Text("По одному в строке: Решение | Ответственный | Срок") }
                }
                if hasOpenQuestions {
                    Section { editor($openQuestionsText, id: "openq", minHeight: 80) } header: { Text("Открытые вопросы") } footer: { Text("По одному в строке") }
                }
                if hasClientRequests {
                    Section { editor($clientRequestsText, id: "clientreq", minHeight: 80) } header: { Text("Требуется от клиента") } footer: { Text("По одному в строке") }
                }
                Section { editor($missingInfoText, id: "missing", minHeight: 60) } header: { Text("Не озвучено — уточнить") } footer: { Text("По одному в строке; пусто — блок не показывается") }
                Section {
                    Text("Action plan редактируется как задачи: раздел «Action plan» в отчёте или вкладка «Задачи».").font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Правка отчёта")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { confirmDiscard = true } }
                ToolbarItem(placement: .confirmationAction) {
                    if exportAfterSave != nil {
                        Menu {
                            Button("Сохранить") { Task { await save(exportAs: nil) } }
                            Button("Сохранить и экспорт Word") { Task { await save(exportAs: "docx") } }
                            Button("Сохранить и экспорт PDF") { Task { await save(exportAs: "pdf") } }
                        } label: { Text(busy ? "Сохраняю…" : "Сохранить") }.disabled(busy)
                    } else {
                        Button(busy ? "Сохраняю…" : "Сохранить") { Task { await save(exportAs: nil) } }.disabled(busy)
                    }
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Готово") { focused = nil } }
            }
            .confirmationDialog("Отменить правки?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Отменить правки", role: .destructive) { dismiss() }
                Button("Продолжить редактирование", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(true)
    }

    private func editor(_ text: Binding<String>, id: String, minHeight: CGFloat) -> some View {
        TextEditor(text: text)
            .font(.body)
            .frame(minHeight: minHeight)
            .focused($focused, equals: id)
    }

    private func lines(_ s: String) -> [String] {
        s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func save(exportAs: String?) async {
        busy = true; defer { busy = false }
        var body = ReportEditBody()
        if title != report.title { body.title = title.trimmingCharacters(in: .whitespaces) }
        let originalSummary = report.sections.first { $0.key == "summary" }?.content ?? report.summary
        var list = sections.filter { s in report.sections.first { $0.key == s.key }?.content != s.text }.map { ReportEditBody.Section(key: $0.key, content: $0.text) }
        if summaryText != originalSummary {
            body.summary = summaryText
            list.append(ReportEditBody.Section(key: "summary", content: summaryText))
        }
        if !list.isEmpty { body.sections = list }
        body.participants = lines(participantsText).map { line in
            let parts = line.components(separatedBy: "·").map { $0.trimmingCharacters(in: .whitespaces) }
            return Participant(name: parts.first ?? line, role: parts.count > 1 ? parts[1] : nil, company: parts.count > 2 ? parts[2] : nil, side: nil)
        }
        if hasDecisions {
            body.decisions = lines(decisionsText).map { line in
                let parts = line.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                return Decision(decision: parts.first ?? line, owner: parts.count > 1 && !parts[1].isEmpty ? parts[1] : nil, deadline: parts.count > 2 && !parts[2].isEmpty ? parts[2] : nil)
            }
        }
        if hasOpenQuestions { body.openQuestions = lines(openQuestionsText) }
        if hasClientRequests { body.clientRequests = lines(clientRequestsText) }
        body.missingInfo = lines(missingInfoText)
        do {
            _ = try await APIClient.shared.editReport(meetingId: meetingId, reportId: report.id, body)
            await onSaved()
            dismiss()
            if let exportAs { exportAfterSave?(exportAs) }
        } catch { self.error = error.localizedDescription }
    }
}
