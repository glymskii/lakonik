import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct MeetingsListView: View {
    @Environment(TemplateStore.self) private var templates
    @Environment(RecordingCoordinator.self) private var recorder
    @Environment(\.scenePhase) private var scenePhase
    @State private var items: [MeetingSummary] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?
    @State private var path = NavigationPath()
    @State private var showImporter = false
    @State private var starting = false
    @State private var startError: String?
    @State private var showOnline = false
    @State private var broadcast: BroadcastManifest?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if items.isEmpty && !loading {
                    ContentUnavailableView {
                        Label("Пока нет встреч", systemImage: "waveform")
                    } description: {
                        Text("Нажмите «Записать встречу» — запись начнётся сразу. Тип встречи можно выбрать во время записи или после расшифровки; отчёт появится через несколько минут.")
                    } actions: {
                        Button("Записать встречу") { Task { await startRecording() } }.buttonStyle(.borderedProminent).disabled(starting)
                    }
                } else {
                    List {
                        if let error { ErrorBanner(message: error).listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                        if let b = broadcast {
                            Button { showOnline = true } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "record.circle").foregroundStyle(.red).symbolEffect(.pulse, options: .repeating)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Идёт запись онлайн-встречи · \(Fmt.clock(b.durationSec))").font(.subheadline.weight(.semibold)).monospacedDigit()
                                        Text("Нажмите, чтобы остановить и отправить на обработку").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                            .listRowBackground(Color.red.opacity(0.08))
                        }
                        ForEach(items) { m in
                            NavigationLink(value: m.id) { MeetingRow(meeting: m) }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Встречи")
            .navigationDestination(for: String.self) { id in MeetingDetailView(meetingId: id) }
            .searchable(text: $query, prompt: "Поиск по названию")
            .onChange(of: query) { _, _ in Task { await load() } }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { Task { await startRecording() } } label: { Label("Записать встречу", systemImage: "record.circle") }
                        if BroadcastStore.isAvailable {
                            Button { showOnline = true } label: { Label("Записать онлайн-встречу (Meet, Zoom)", systemImage: "video.badge.waveform") }
                        }
                        Button { showImporter = true } label: { Label("Импортировать аудио / видео", systemImage: "square.and.arrow.down") }
                    } label: { Label("Добавить", systemImage: "plus") }
                    .disabled(recorder.isActive || starting)
                }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.audio, .movie, .mpeg4Movie, .mpeg4Audio, .mp3, .wav, .quickTimeMovie], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { Task { await importFile(url) } }
            }
            .alert("Не удалось начать запись", isPresented: Binding(get: { startError != nil }, set: { if !$0 { startError = nil } })) {
                Button("OK") { startError = nil }
            } message: { Text(startError ?? "") }
            .safeAreaInset(edge: .bottom) {
                if !items.isEmpty {
                    Button { Task { await startRecording() } } label: {
                        Label("Записать встречу", systemImage: "record.circle")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(recorder.isActive || starting)
                    .padding(.horizontal, 16).padding(.bottom, 8)
                    .background(.bar)
                }
            }
            .task {
                broadcast = BroadcastStore.active()
                await templates.refresh()
                await load()
                await BroadcastImporter.shared.importFinished()
                PushRegistrar.shared.requestAuthorizationAndRegister()
                await PushRegistrar.shared.sync()
                PushRegistrar.shared.onOpenMeeting = { id in path.append(id) }
            }
            .sheet(isPresented: $showOnline) { OnlineMeetingView() }
            .onReceive(NotificationCenter.default.publisher(for: .meetingsChanged)) { _ in Task { await load() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    broadcast = BroadcastStore.active()
                    Task { await load(); await BroadcastImporter.shared.importFinished() }
                }
            }
            .onChange(of: recorder.isPresentingRecorder) { _, presenting in if !presenting { broadcast = BroadcastStore.active() } }
            .onChange(of: recorder.finalizedMeetingId) { _, id in
                if let id {
                    recorder.reset()
                    Task { await load() }
                    path.append(id)
                }
            }
        }
    }

    /// Быстрый старт: встреча создаётся без типа, запись начинается сразу. Тип — с экрана записи или после расшифровки.
    private func startRecording() async {
        guard !starting, !recorder.isActive else { return }
        starting = true
        defer { starting = false }
        do {
            let created = try await APIClient.shared.createMeeting(CreateMeetingBody(templateId: nil, deviceId: UIDevice.current.identifierForVendor?.uuidString))
            try await recorder.start(serverMeeting: created, template: nil)
        } catch {
            startError = error.localizedDescription
        }
    }

    private func importFile(_ url: URL) async {
        guard !starting, !recorder.isActive else { return }
        starting = true
        defer { starting = false }
        do {
            let created = try await APIClient.shared.createMeeting(CreateMeetingBody(templateId: nil, title: url.deletingPathExtension().lastPathComponent, source: "imported", deviceId: UIDevice.current.identifierForVendor?.uuidString))
            try await recorder.importFile(url, serverMeeting: created, template: nil)
        } catch {
            startError = error.localizedDescription
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await APIClient.shared.meetings(query: query).items
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct MeetingRow: View {
    let meeting: MeetingSummary
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(meeting.templateEmoji).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(meeting.title).font(.body.weight(.medium)).lineLimit(2)
                Text("\(meeting.templateTitle) · \(Fmt.dateTime.string(from: meeting.startedAt)) · \(Fmt.duration(meeting.durationSec))")
                    .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    StatusBadge(status: meeting.status)
                    if meeting.confidentiality == "restricted" { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary) }
                    if !meeting.isOwner { Image(systemName: "person.2").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
