import ActivityKit
import AVFoundation
import Foundation
import Observation
import os
import UIKit

/// Управляет жизненным циклом записи встречи: рекордер, сегменты, Live Activity, прерывания, финализация.
@Observable
@MainActor
final class RecordingCoordinator {
    static let shared = RecordingCoordinator()

    enum Phase: Equatable { case idle, recording, paused, interrupted, stopping, uploading, finalizing, finished, failed(String) }

    private(set) var phase: Phase = .idle
    private(set) var meeting: LocalMeeting?
    private(set) var elapsed: TimeInterval = 0
    /// Часы записи и огибающая для визуализации (читается экраном записи напрямую, без прохода через @Observable)
    let levels = LevelHistory()
    private(set) var uploadedSegments = 0
    private(set) var totalSegments = 0
    var isPresentingRecorder = false
    /// id встречи, обработка которой только что запущена — для перехода на экран прогресса
    var finalizedMeetingId: String?

    private let log = Logger(subsystem: "kz.adv.meetings", category: "recording")
    private var recorder: AudioRecorder?
    private var timer: Timer?
    /// Идёт отмена записи: закрывающийся последний сегмент не регистрируем и не загружаем
    private var discarding = false
    private var activity: Activity<RecordingActivityAttributes>?
    private var uploadObserver: Task<Void, Never>?
    /// Встречи, финализация которых уже идёт (защита от двойного finalize из разных источников)
    private var finalizing: Set<String> = []

    var isActive: Bool { if case .idle = phase { return false }; if case .finished = phase { return false }; return true }

    func bootstrap() {
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main) { [weak self] n in
            Task { @MainActor in self?.handleInterruption(n) }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.handleMediaReset() }
        }
        uploadObserver = Task { [weak self] in
            for await ev in UploadManager.shared.events {
                await self?.handleUploadEvent(ev)
            }
        }
        // Незавершённые записи после перезапуска приложения: дозагрузить и финализировать
        Task {
            await resumePendingFinalizations()
            if AudioRetention.current == .week { await LocalStore.shared.purgeOlderThan(days: 7) }
        }
    }

    // MARK: Start / pause / stop

    /// Тип встречи не выбран — быстрая запись; тип задаётся во время записи или после расшифровки
    static let unclassifiedTemplateCode = "unclassified"

    func start(serverMeeting: MeetingSummary, template: MeetingTemplate?) async throws {
        guard phase == .idle || phase == .finished else { return }
        try await ensureMicPermission()
        let local = LocalMeeting(id: serverMeeting.id, title: serverMeeting.title, templateId: template?.id ?? serverMeeting.templateId, templateTitle: template?.title ?? serverMeeting.templateTitle, templateEmoji: template?.emoji ?? serverMeeting.templateEmoji, templateCode: template?.code ?? serverMeeting.templateCode, startedAt: Date())
        await LocalStore.shared.upsert(local)
        meeting = local
        let dir = await LocalStore.shared.directory(for: local.id)

        let r = AudioRecorder()
        let meetingId = local.id
        r.onSegmentClosed = { [weak self] seg in Task { @MainActor in await self?.segmentClosed(seg, meetingId: meetingId) } }
        r.onLevel = { [levels] raw in levels.append(raw) } // прямо с аудиопотока, без прыжка на main
        r.onStateChanged = { [weak self] s in Task { @MainActor in self?.recorderStateChanged(s) } }
        recorder = r
        levels.begin()
        do { try r.start(in: dir) } catch {
            // Микрофон не стартовал (обычно занят звонком в другом приложении) — не оставляем «висящую» встречу
            levels.clear(); recorder = nil; meeting = nil
            await LocalStore.shared.remove(local.id)
            try? await APIClient.shared.deleteMeeting(local.id)
            NotificationCenter.default.post(name: .meetingsChanged, object: nil)
            throw Self.describeStartError(error)
        }

        elapsed = 0
        uploadedSegments = 0
        totalSegments = 0
        phase = .recording
        startTimer()
        startActivity(local)
        UIApplication.shared.isIdleTimerDisabled = false
        isPresentingRecorder = true
    }

    /// Понятное объяснение ошибки старта аудиосессии: iOS не отдаёт микрофон, пока в другом приложении идёт звонок
    private static func describeStartError(_ error: Error) -> Error {
        let ns = error as NSError
        let busy: Set<Int> = [Int(AVAudioSession.ErrorCode.insufficientPriority.rawValue), Int(AVAudioSession.ErrorCode.cannotStartRecording.rawValue)]
        guard ns.domain == NSOSStatusErrorDomain, busy.contains(ns.code) else { return error }
        let hint = BroadcastStore.isAvailable
            ? "Для записи онлайн-встречи используйте «Записать онлайн-встречу» в меню «+»."
            : "Завершите звонок или запишите встречу с другого устройства."
        return NSError(domain: "Recording", code: ns.code, userInfo: [NSLocalizedDescriptionKey: "Микрофон занят: в другом приложении идёт звонок (Meet, Zoom, телефон). \(hint)"])
    }

    func pause() {
        guard phase == .recording, let recorder else { return }
        recorder.pause()
        levels.pause()
        phase = .paused
        updateActivity()
    }

    func resume() {
        guard phase == .paused || phase == .interrupted, let recorder else { return }
        do {
            try recorder.resume()
            levels.resume()
            phase = .recording
            updateActivity()
        } catch {
            log.error("resume failed: \(error.localizedDescription)")
            phase = .failed("Не удалось продолжить запись: \(error.localizedDescription)")
        }
    }

    /// Тип встречи выбран во время записи: обновляем заголовок и эмодзи на экране записи и в Live Activity
    func applyTemplate(_ t: MeetingTemplate, title: String) {
        guard let meeting else { return }
        Task {
            if let updated = await LocalStore.shared.update(meeting.id, { $0.templateId = t.id; $0.templateTitle = t.title; $0.templateEmoji = t.emoji; $0.templateCode = t.code; $0.title = title }) {
                self.meeting = updated
                updateActivity()
            }
        }
    }

    /// Тип встречи ещё не выбран
    var isUnclassified: Bool { meeting?.templateCode == Self.unclassifiedTemplateCode }

    func addMarker(note: String?) {
        guard let meeting, isActive else { return }
        let m = Marker(atSec: levels.now, note: note, createdAt: ISO8601DateFormatter.fractional.string(from: Date()))
        Task {
            if let updated = await LocalStore.shared.update(meeting.id, { $0.markers.append(m) }) { self.meeting = updated }
        }
    }

    func stop() async {
        guard let recorder, let meeting, phase != .stopping else { return }
        phase = .stopping
        stopTimer()
        recorder.stop() // синхронно закрывает последний сегмент → segmentClosed
        levels.freeze()
        self.recorder = nil
        let updated = await LocalStore.shared.update(meeting.id) { $0.phase = .stopped; $0.endedAt = Date() }
        self.meeting = updated
        await endActivity()
        phase = .uploading
        await UploadManager.shared.kick()
        await tryFinalize(meetingId: meeting.id)
    }

    /// Отмена записи: удаляет встречу на сервере и локальные файлы.
    /// Порядок важен: сначала запись убирается из LocalStore (там же удаляются файлы — атомарно относительно создания
    /// upload-задач), потом отменяются уже запущенные загрузки. Иначе фоновая URLSession получала файл, удалённый
    /// между presign и созданием задачи, и падала с необрабатываемым исключением.
    func discard() async {
        guard let meeting, !discarding else { return }
        discarding = true
        defer { discarding = false }
        phase = .stopping
        stopTimer()
        recorder?.stop()
        levels.freeze()
        recorder = nil
        await endActivity()
        await LocalStore.shared.remove(meeting.id)
        await UploadManager.shared.cancel(meetingId: meeting.id)
        try? await APIClient.shared.deleteMeeting(meeting.id)
        self.meeting = nil
        levels.clear()
        elapsed = 0
        phase = .idle
        isPresentingRecorder = false
        NotificationCenter.default.post(name: .meetingsChanged, object: nil)
    }

    func reset() {
        meeting = nil
        phase = .idle
        elapsed = 0
        levels.clear()
        finalizedMeetingId = nil
        isPresentingRecorder = false
    }

    // MARK: Segments & upload

    private func segmentClosed(_ seg: AudioRecorder.ClosedSegment, meetingId: String) async {
        // Сегмент отменённой или уже другой записи не регистрируем (файлы отменённой записи удалены)
        guard let meeting, meeting.id == meetingId, !discarding else { return }
        let local = LocalSegment(meetingId: meeting.id, seq: seg.seq, fileName: seg.url.lastPathComponent, durationSec: seg.durationSec, sizeBytes: seg.sizeBytes)
        if let updated = await LocalStore.shared.update(meeting.id, { $0.segments.append(local) }) {
            self.meeting = updated
            totalSegments = updated.segments.count
        }
        await UploadManager.shared.kick()
        updateActivity()
    }

    private func handleUploadEvent(_ ev: UploadManager.Event) async {
        guard let meeting, ev.meetingId == meeting.id else { return }
        if let m = await LocalStore.shared.meeting(meeting.id) {
            self.meeting = m
            uploadedSegments = m.uploadedCount
            totalSegments = m.segments.count
        }
        updateActivity()
        if phase == .uploading { await tryFinalize(meetingId: meeting.id) }
    }

    private func tryFinalize(meetingId: String) async {
        guard !finalizing.contains(meetingId) else { return }
        finalizing.insert(meetingId)
        defer { finalizing.remove(meetingId) }
        guard let m = await LocalStore.shared.meeting(meetingId), m.phase == .stopped || m.phase == .finalizing else { return }
        guard m.allUploaded else { return }
        phase = .finalizing
        _ = await LocalStore.shared.update(meetingId) { $0.phase = .finalizing }
        do {
            let ended = m.endedAt ?? Date()
            _ = try await APIClient.shared.finalize(meetingId: meetingId, body: FinalizeBody(endedAt: ISO8601DateFormatter.fractional.string(from: ended), durationSec: Int(m.recordedSeconds.rounded()), markers: m.markers))
            _ = await LocalStore.shared.update(meetingId) { $0.phase = .finalized }
            if !(m.keepAudio || AudioRetention.current == .manual) {
                // По умолчанию аудио на устройстве удаляем после успешной постановки в обработку (сервер уже всё получил).
                if AudioRetention.current == .afterUpload { await LocalStore.shared.deleteAudio(meetingId: meetingId) }
            }
            finalizedMeetingId = meetingId
            phase = .finished
        } catch {
            log.error("finalize failed: \(error.localizedDescription)")
            _ = await LocalStore.shared.update(meetingId) { $0.phase = .stopped; $0.finalizeError = error.localizedDescription }
            phase = .failed("Не удалось отправить запись на обработку: \(error.localizedDescription)")
        }
    }

    /// После перезапуска: записи в фазе stopped/finalizing — дозагрузить и финализировать;
    /// записи, оборванные крашем в фазе recording — закрыть (есть сегменты) или удалить (пустые).
    func resumePendingFinalizations() async {
        var changed = false
        for m in await LocalStore.shared.all() where m.phase == .recording {
            if m.segments.isEmpty {
                log.warning("незавершённая пустая запись \(m.id) — удаляю")
                await LocalStore.shared.remove(m.id)
                try? await APIClient.shared.deleteMeeting(m.id)
                changed = true
            } else {
                log.warning("незавершённая запись \(m.id) с \(m.segments.count) сегментами — закрываю")
                _ = await LocalStore.shared.update(m.id) { $0.phase = .stopped; $0.endedAt = $0.endedAt ?? Date() }
            }
        }
        if changed { NotificationCenter.default.post(name: .meetingsChanged, object: nil) }
        await UploadManager.shared.kick()
        for m in await LocalStore.shared.all() where m.phase == .stopped || m.phase == .finalizing {
            if m.allUploaded {
                await finalizeDetached(meetingId: m.id)
            }
        }
    }

    /// Импорт готового аудио/видео файла (Zoom, Teams, диктофон): копируем в локальную папку встречи как сегмент 0 и отправляем.
    func importFile(_ sourceURL: URL, serverMeeting: MeetingSummary, template: MeetingTemplate?) async throws {
        let local = LocalMeeting(id: serverMeeting.id, title: serverMeeting.title, templateId: template?.id ?? serverMeeting.templateId, templateTitle: template?.title ?? serverMeeting.templateTitle, templateEmoji: template?.emoji ?? serverMeeting.templateEmoji, templateCode: template?.code ?? serverMeeting.templateCode, startedAt: Date(), endedAt: Date(), phase: .stopped)
        await LocalStore.shared.upsert(local)
        let dir = await LocalStore.shared.directory(for: local.id)
        let ext = sourceURL.pathExtension.isEmpty ? "m4a" : sourceURL.pathExtension.lowercased()
        let dest = dir.appending(path: "0000.\(ext)")
        let accessing = sourceURL.startAccessingSecurityScopedResource()
        defer { if accessing { sourceURL.stopAccessingSecurityScopedResource() } }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.copyItem(at: sourceURL, to: dest)
        let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
        let duration = (try? await AVURLAsset(url: dest).load(.duration).seconds) ?? 0
        let seg = LocalSegment(meetingId: local.id, seq: 0, fileName: dest.lastPathComponent, durationSec: duration.isFinite ? duration : 0, sizeBytes: size)
        _ = await LocalStore.shared.update(local.id) { $0.segments = [seg] }
        meeting = await LocalStore.shared.meeting(local.id)
        phase = .uploading
        totalSegments = 1
        uploadedSegments = 0
        isPresentingRecorder = true
        await UploadManager.shared.kick()
    }

    /// Повтор отправки после ошибки (кнопка на экране записи)
    func retryFinalize() async {
        guard let id = meeting?.id else { return }
        phase = .uploading
        await UploadManager.shared.kick()
        await tryFinalize(meetingId: id)
    }

    func finalizeDetached(meetingId: String) async {
        // Если координатор ведёт эту встречу — финализирует он сам (tryFinalize)
        if meeting?.id == meetingId, isActive { return }
        guard !finalizing.contains(meetingId) else { return }
        finalizing.insert(meetingId)
        defer { finalizing.remove(meetingId) }
        guard let m = await LocalStore.shared.meeting(meetingId), m.allUploaded, m.phase == .stopped || m.phase == .finalizing else { return }
        do {
            _ = try await APIClient.shared.finalize(meetingId: meetingId, body: FinalizeBody(endedAt: ISO8601DateFormatter.fractional.string(from: m.endedAt ?? Date()), durationSec: Int(m.recordedSeconds.rounded()), markers: m.markers))
            _ = await LocalStore.shared.update(meetingId) { $0.phase = .finalized }
            if AudioRetention.current == .afterUpload { await LocalStore.shared.deleteAudio(meetingId: meetingId) }
        } catch {
            log.error("detached finalize failed: \(error.localizedDescription)")
        }
    }

    // MARK: Interruptions

    private func handleInterruption(_ n: Notification) {
        guard let info = n.userInfo, let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            guard phase == .recording else { return }
            log.warning("interruption began (звонок / Siri)")
            recorder?.markInterrupted()
            levels.pause()
            phase = .interrupted
            updateActivity()
        case .ended:
            guard phase == .interrupted else { return }
            let opts = AVAudioSession.InterruptionOptions(rawValue: (info[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
            if opts.contains(.shouldResume) {
                log.info("interruption ended → resume")
                resume()
            } else {
                // Система не рекомендует авто-возобновление — пробуем через секунду, иначе оставляем на паузе
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    if phase == .interrupted { resume() }
                }
            }
        @unknown default: break
        }
    }

    private func handleMediaReset() {
        guard isActive, phase != .stopping else { return }
        log.error("media services reset — пробуем возобновить")
        phase = .interrupted
        resume()
    }

    private func recorderStateChanged(_ s: AudioRecorder.State) {
        if s == .interrupted, phase == .recording { phase = .interrupted; levels.pause(); updateActivity() }
    }

    // MARK: Timer & activity

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopTimer() { timer?.invalidate(); timer = nil }

    private func tick() { elapsed = levels.now }

    private func startActivity(_ m: LocalMeeting) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attrs = RecordingActivityAttributes(meetingId: m.id, title: m.title, templateEmoji: m.templateEmoji)
        let state = RecordingActivityAttributes.ContentState(timerStart: Date(), isPaused: false, pausedElapsed: 0, uploadedSegments: 0, totalSegments: 0)
        do {
            activity = try Activity.request(attributes: attrs, content: .init(state: state, staleDate: nil), pushType: nil)
        } catch {
            log.error("Live Activity: \(error.localizedDescription)")
        }
    }

    private func updateActivity() {
        guard let activity else { return }
        elapsed = levels.now
        let isPaused = phase == .paused || phase == .interrupted
        let state = RecordingActivityAttributes.ContentState(
            timerStart: Date().addingTimeInterval(-elapsed),
            isPaused: isPaused,
            pausedElapsed: elapsed,
            uploadedSegments: uploadedSegments,
            totalSegments: totalSegments
        )
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    private func endActivity() async {
        guard let activity else { return }
        let state = RecordingActivityAttributes.ContentState(timerStart: Date().addingTimeInterval(-elapsed), isPaused: true, pausedElapsed: elapsed, uploadedSegments: uploadedSegments, totalSegments: totalSegments)
        await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: .immediate)
        self.activity = nil
    }

    // MARK: Permissions

    private func ensureMicPermission() async throws {
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = await AVAudioApplication.requestRecordPermission()
        } else {
            granted = await withCheckedContinuation { c in AVAudioSession.sharedInstance().requestRecordPermission { c.resume(returning: $0) } }
        }
        guard granted else { throw NSError(domain: "Recording", code: 403, userInfo: [NSLocalizedDescriptionKey: "Нет доступа к микрофону. Разрешите его в Настройках → Lakonik."]) }
    }
}

/// Политика хранения аудио на устройстве
enum AudioRetention: String, CaseIterable, Identifiable {
    case afterUpload, week, manual
    var id: String { rawValue }
    var title: String {
        switch self {
        case .afterUpload: return "Удалять после отправки на обработку"
        case .week: return "Хранить 7 дней"
        case .manual: return "Хранить, удалять вручную"
        }
    }
    static var current: AudioRetention {
        get { AudioRetention(rawValue: UserDefaults.standard.string(forKey: "audioRetention") ?? "") ?? .afterUpload }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "audioRetention") }
    }
}
