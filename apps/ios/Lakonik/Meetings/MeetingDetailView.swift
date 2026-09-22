import SwiftUI

@MainActor
struct MeetingDetailView: View {
    let meetingId: String
    @Environment(TemplateStore.self) private var templates
    @Environment(\.dismiss) private var dismiss
    @State private var detail: MeetingDetail?
    @State private var error: String?
    @State private var tab: Tab = .report
    @State private var watchGeneration = 0
    @State private var exporting = false
    @State private var exportURL: URL?
    @State private var showRegenerate = false
    @State private var showShare = false
    @State private var confirmDelete = false
    @State private var busy = false
    @State private var editingTask: TaskItem?
    @State private var addingTask = false
    @State private var editingReport = false
    @State private var showReview = false

    enum Tab: String, CaseIterable { case report = "Отчёт", transcript = "Транскрипт", info = "Инфо" }

    var body: some View {
        Group {
            if let d = detail {
                content(d)
            } else if let error {
                ContentUnavailableView("Не удалось загрузить", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(detail?.title ?? "Встреча")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task { await load(); await watchStatus() }
        .task(id: watchGeneration) { if watchGeneration > 0 { await load(); await watchStatus() } }
        .sheet(item: $exportURL) { url in ShareSheet(items: [url]) }
        .sheet(isPresented: $showRegenerate) { if let d = detail { RegenerateSheet(detail: d) { watchGeneration += 1 } } }
        .sheet(isPresented: $showShare) { if let d = detail { SharesSheet(meetingId: d.id) } }
        .sheet(isPresented: $showReview) { if let d = detail { ReviewFlowView(detail: d) { watchGeneration += 1 } } }
        .sheet(item: $editingTask) { t in TaskEditorView(task: t) { _ in await load() } }
        .sheet(isPresented: $editingReport) {
            if let d = detail, let r = d.report {
                ReportEditorView(meetingId: d.id, report: r, onSaved: { await load() }, exportAfterSave: { fmt in Task { await export(fmt) } })
            }
        }
        .sheet(isPresented: $addingTask) { NewTaskView(meetingId: meetingId) { _ in await load() } }
        .confirmationDialog("Удалить встречу вместе с транскриптом и отчётом?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive) { Task { try? await APIClient.shared.deleteMeeting(meetingId); await LocalStore.shared.remove(meetingId); await UploadManager.shared.cancel(meetingId: meetingId); dismiss() } }
        }
    }

    @ViewBuilder private func content(_ d: MeetingDetail) -> some View {
        VStack(spacing: 0) {
            if d.status.isInProgress || d.status == .failed || d.status == .recording {
                ProcessingBanner(detail: d) { Task { await retry() } }
            } else if d.status == .transcribed, d.isOwner {
                TranscribedBanner(detail: d) { showReview = true }
            }
            if d.hasReport || d.hasTranscript {
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            switch tab {
            case .report:
                if let r = d.report {
                    ReportView(report: r, meeting: d, tasks: d.tasks, onToggleTask: { t in await toggleTask(t) }, onEditTask: { editingTask = $0 }, onAddTask: { addingTask = true }, onEditReport: { editingReport = true }, onAIFix: { showRegenerate = true })
                }
                else if d.status == .transcribed {
                    ContentUnavailableView {
                        Label("Расшифровка готова", systemImage: "text.badge.checkmark")
                    } description: {
                        Text(d.isOwner ? "Проверьте, кто говорил, выберите тип встречи — и отчёт будет готов через пару минут. Транскрипт уже доступен во вкладке рядом." : "Владелец ещё не сформировал отчёт. Транскрипт — во вкладке рядом.")
                    } actions: {
                        if d.isOwner { Button("Проверить спикеров и сформировать отчёт") { showReview = true }.buttonStyle(.borderedProminent) }
                    }
                }
                else if !d.status.isInProgress { ContentUnavailableView("Отчёта пока нет", systemImage: "doc.text", description: Text(d.status == .failed ? (d.error ?? "Обработка не удалась") : "Отчёт появится после обработки записи.")) }
                else { Spacer() }
            case .transcript:
                if let t = d.transcript { TranscriptView(transcript: t, meetingId: d.id, canEdit: d.isOwner) { await load() } }
                else { ContentUnavailableView("Транскрипта нет", systemImage: "text.quote") }
            case .info:
                MeetingInfoView(detail: d, template: templates.template(id: d.templateId))
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if detail?.hasReport == true && detail?.isOwner == true {
                    Button { editingReport = true } label: { Label("Редактировать текст отчёта", systemImage: "pencil.line") }
                }
                if detail?.hasReport == true {
                    Section("Экспорт отчёта") {
                        Button { Task { await export("docx") } } label: { Label("Word (.docx)", systemImage: "doc.richtext") }
                        Button { Task { await export("pdf") } } label: { Label("PDF", systemImage: "doc") }
                        Button { Task { await export("md") } } label: { Label("Markdown", systemImage: "text.alignleft") }
                    }
                }
                if detail?.hasTranscript == true {
                    Button { Task { await export("txt") } } label: { Label("Транскрипт (.txt)", systemImage: "text.quote") }
                }
                if detail?.hasTranscript == true && detail?.isOwner == true {
                    if detail?.status == .transcribed {
                        Button { showReview = true } label: { Label("Проверить спикеров и сформировать отчёт…", systemImage: "person.2.badge.gearshape") }
                    } else {
                        Button { showRegenerate = true } label: { Label("Исправить / пересобрать отчёт…", systemImage: "wand.and.stars") }
                    }
                }
                if detail?.isOwner == true {
                    Button { showShare = true } label: { Label("Поделиться с коллегой", systemImage: "person.badge.plus") }
                    Divider()
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Удалить встречу", systemImage: "trash") }
                }
            } label: {
                if exporting || busy { ProgressView() } else { Image(systemName: "ellipsis.circle") }
            }
            .disabled(detail == nil)
        }
    }

    private func load() async {
        do { detail = try await APIClient.shared.meeting(meetingId); error = nil } catch { self.error = error.localizedDescription }
    }

    /// Следит за статусом обработки через SSE (отменяется SwiftUI при уходе с экрана); при обрыве — опрос раз в 5 с.
    private func watchStatus() async {
        guard let d = detail, d.status.isInProgress || d.status == .recording else { return }
        do {
            for try await ev in APIClient.shared.statusEvents(meetingId: meetingId) {
                if Task.isCancelled { return }
                await load()
                if ev.status == .done || ev.status == .failed || ev.status == .transcribed { return }
            }
        } catch {
            if Task.isCancelled { return }
        }
        while !Task.isCancelled, let d = detail, d.status.isInProgress {
            try? await Task.sleep(for: .seconds(5))
            if Task.isCancelled { return }
            await load()
        }
    }

    private func retry() async {
        busy = true; defer { busy = false }
        _ = try? await APIClient.shared.retry(meetingId: meetingId)
        watchGeneration += 1
    }

    private func export(_ format: String) async {
        exporting = true; defer { exporting = false }
        do {
            let data = try await APIClient.shared.export(meetingId: meetingId, format: format)
            let name = (detail?.title ?? "report").replacingOccurrences(of: "/", with: "-").prefix(60)
            let url = URL.temporaryDirectory.appending(path: "\(name).\(format)")
            try data.write(to: url, options: .atomic)
            exportURL = url
        } catch { self.error = error.localizedDescription }
    }

    private func toggleTask(_ t: TaskItem) async {
        guard var d = detail else { return }
        do {
            let updated = try await APIClient.shared.updateTask(t.id, TaskPatch(status: t.isDone ? .open : .done))
            var list = d.tasks
            if let i = list.firstIndex(where: { $0.id == t.id }) { list[i] = updated }
            d = d.with(tasks: list)
            detail = d
        } catch { self.error = error.localizedDescription }
    }
}

extension URL: @retroactive Identifiable { public var id: String { absoluteString } }

struct ProcessingBanner: View {
    let detail: MeetingDetail
    let onRetry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if detail.status.isInProgress { ProgressView() }
                Image(systemName: detail.status == .failed ? "exclamationmark.triangle.fill" : "waveform.and.magnifyingglass")
                    .foregroundStyle(detail.status == .failed ? .red : .accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(detail.status.title).font(.subheadline.weight(.semibold))
                    Text(detail.status == .failed ? (detail.error ?? "Не удалось обработать запись") : (detail.statusDetail.flatMap { $0 == detail.status.title ? nil : $0 } ?? "Обычно занимает 2–5 минут. Можно закрыть — пришлём уведомление."))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if detail.status == .failed && detail.isOwner { Button("Повторить", action: onRetry).buttonStyle(.bordered).controlSize(.small) }
            }
            if detail.status.isInProgress { PipelineSteps(status: detail.status) }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
    }
}

/// Расшифровка готова, отчёта ещё нет: владелец проверяет спикеров и выбирает тип встречи
struct TranscribedBanner: View {
    let detail: MeetingDetail
    let onReview: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "text.badge.checkmark").foregroundStyle(.green).font(.title3)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Расшифровка готова").font(.subheadline.weight(.semibold))
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                }
            }
            Button(action: onReview) {
                Label("Проверить спикеров и выбрать тип встречи", systemImage: "arrow.right.circle.fill").font(.subheadline.weight(.medium)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.small)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
    }
    private var hint: String {
        guard let t = detail.transcript else { return "Чтобы получить отчёт, выберите тип встречи." }
        if let s = t.speakerSuggestions {
            let diarized = t.speakerIds.count
            let dup = s.speakers.filter { $0.sameAs != nil }.count
            var parts = ["ИИ насчитал \(s.estimatedSpeakerCount) участников"]
            if diarized > s.estimatedSpeakerCount { parts.append("разделение выделило \(diarized)") }
            if dup > 0 { parts.append("\(dup) возможных дубля — объедините") }
            return parts.joined(separator: ", ") + ". Подтвердите, кто есть кто, и выберите тип встречи для отчёта."
        }
        return "Подтвердите, кто говорил (\(t.speakerIds.count) спикеров), и выберите тип встречи для отчёта."
    }
}

struct PipelineSteps: View {
    let status: MeetingStatus
    private let steps: [(MeetingStatus, String)] = [(.queued, "Очередь"), (.processing, "Аудио"), (.transcribing, "Расшифровка"), (.summarizing, "Отчёт")]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                let idx = steps.firstIndex { $0.0 == status } ?? -1
                let done = i < idx, current = i == idx
                HStack(spacing: 4) {
                    Circle().fill(done ? Color.green : current ? Color.accentColor : Color.secondary.opacity(0.3)).frame(width: 8, height: 8)
                    Text(step.1).font(.caption2).foregroundStyle(current ? .primary : .secondary).lineLimit(1).fixedSize()
                }
                if i < steps.count - 1 { Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 1) }
            }
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
