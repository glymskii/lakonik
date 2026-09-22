import Foundation
import os

/// Загрузка сегментов на presigned URL через фоновую URLSession: продолжается при блокировке экрана и после сворачивания.
final class UploadManager: NSObject {
    static let shared = UploadManager()

    struct Event: Sendable { let meetingId: String; let seq: Int; let state: LocalSegment.UploadState }

    private let log = Logger(subsystem: "kz.adv.meetings", category: "upload")
    private let sessionId = "kz.adv.meetings.upload"
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: sessionId)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.allowsCellularAccess = true
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForResource = 60 * 60 * 6
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    var backgroundCompletionHandler: (() -> Void)?

    private let (eventStream, eventContinuation) = AsyncStream<Event>.makeStream()
    var events: AsyncStream<Event> { eventStream }

    private struct State { var inFlight: Set<String> = []; var kicking = false } // inFlight: "meetingId/seq"
    private let state = OSAllocatedUnfairLock(initialState: State())

    func bootstrap() {
        _ = session // пересоздать фоновую сессию, чтобы получить события завершённых задач
        Task { await reconcile() }
    }

    /// Ставит в загрузку все pending-сегменты (идемпотентно).
    func kick() async {
        let shouldRun = state.withLock { st -> Bool in
            if st.kicking { return false }
            st.kicking = true
            return true
        }
        guard shouldRun else { return }
        defer { state.withLock { $0.kicking = false } }

        let pending = await LocalStore.shared.pendingSegments()
        for seg in pending {
            let already = state.withLock { $0.inFlight.contains(seg.id) }
            if already { continue }
            await enqueue(seg)
        }
    }

    private func enqueue(_ seg: LocalSegment) async {
        let fileURL = await LocalStore.shared.fileURL(for: seg)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            log.error("segment file missing: \(fileURL.lastPathComponent)")
            await LocalStore.shared.updateSegment(meetingId: seg.meetingId, seq: seg.seq) { $0.uploadState = .failed; $0.lastError = "Файл сегмента не найден" }
            return
        }
        do {
            let ext = (seg.fileName as NSString).pathExtension.lowercased()
            let contentType: String = ["m4a": "audio/mp4", "mp4": "video/mp4", "mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac", "ogg": "audio/ogg"][ext] ?? "audio/mp4"
            let presigned = try await APIClient.shared.requestSegmentUpload(meetingId: seg.meetingId, seq: seg.seq, kind: seg.seq == 0 && ext != "m4a" ? "import" : "segment", contentType: contentType, ext: ext.isEmpty ? "m4a" : ext)
            guard let url = URL(string: presigned.uploadUrl) else { throw APIError.server(status: 0, message: "Некорректный URL загрузки") }
            var req = URLRequest(url: url)
            req.httpMethod = "PUT"
            for (k, v) in presigned.headers { req.setValue(v, forHTTPHeaderField: k) }
            // Задача создаётся внутри actor'а LocalStore — атомарно относительно удаления файлов (отмена/удаление записи)
            guard let task = await LocalStore.shared.withSegmentFile(seg, { self.session.uploadTask(with: req, fromFile: $0) }) else {
                log.warning("segment \(seg.id) removed before upload — skip")
                return
            }
            task.taskDescription = "\(seg.meetingId)|\(seg.seq)|\(seg.durationSec)|\(seg.sizeBytes)"
            state.withLock { _ = $0.inFlight.insert(seg.id) }
            await LocalStore.shared.updateSegment(meetingId: seg.meetingId, seq: seg.seq) { $0.uploadState = .uploading; $0.attempts += 1 }
            task.resume()
            log.info("upload started \(seg.id) (\(seg.sizeBytes) bytes)")
        } catch {
            log.error("presign failed \(seg.id): \(error.localizedDescription)")
            await LocalStore.shared.updateSegment(meetingId: seg.meetingId, seq: seg.seq) { $0.uploadState = .failed; $0.lastError = error.localizedDescription }
            eventContinuation.yield(Event(meetingId: seg.meetingId, seq: seg.seq, state: .failed))
        }
    }

    /// Отмена загрузок встречи (отмена или удаление записи): снимает запущенные задачи; новые не появятся, т.к. записи
    /// уже нет в LocalStore.
    func cancel(meetingId: String) async {
        for t in await session.allTasks where t.taskDescription?.hasPrefix("\(meetingId)|") == true { t.cancel() }
        state.withLock { $0.inFlight = $0.inFlight.filter { !$0.hasPrefix("\(meetingId)/") } }
    }

    /// После перезапуска: сегменты со статусом uploading без живой задачи → pending.
    private func reconcile() async {
        let tasks = await session.allTasks
        let live = Set(tasks.compactMap { $0.taskDescription?.split(separator: "|").prefix(2).joined(separator: "/") })
        state.withLock { $0.inFlight = live }
        for m in await LocalStore.shared.all() {
            for s in m.segments where s.uploadState == .uploading && !live.contains(s.id) {
                await LocalStore.shared.updateSegment(meetingId: m.id, seq: s.seq) { $0.uploadState = .pending }
            }
        }
        await kick()
    }

    private func parse(_ task: URLSessionTask) -> (meetingId: String, seq: Int, duration: Double, size: Int)? {
        guard let d = task.taskDescription else { return nil }
        let p = d.split(separator: "|").map(String.init)
        guard p.count >= 2, let seq = Int(p[1]) else { return nil }
        return (p[0], seq, p.count > 2 ? Double(p[2]) ?? 0 : 0, p.count > 3 ? Int(p[3]) ?? 0 : 0)
    }
}

extension UploadManager: URLSessionTaskDelegate, URLSessionDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let info = parse(task) else { return }
        let key = "\(info.meetingId)/\(info.seq)"
        state.withLock { _ = $0.inFlight.remove(key) }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let ok = error == nil && (200..<300).contains(status)
        Task {
            if ok {
                await LocalStore.shared.updateSegment(meetingId: info.meetingId, seq: info.seq) { $0.uploadState = .uploaded; $0.lastError = nil }
                log.info("uploaded \(key)")
                // Подтверждение серверу (при финализации сервер и сам проверит объект в bucket)
                try? await APIClient.shared.completeSegment(meetingId: info.meetingId, seq: info.seq, durationSec: info.duration > 0 ? info.duration : nil, sizeBytes: info.size > 0 ? info.size : nil)
                eventContinuation.yield(Event(meetingId: info.meetingId, seq: info.seq, state: .uploaded))
                // Если приложение не активно, а встреча остановлена и всё загружено — финализируем отсюда
                if let m = await LocalStore.shared.meeting(info.meetingId), m.phase == .stopped, m.allUploaded {
                    await RecordingCoordinator.shared.finalizeDetached(meetingId: info.meetingId)
                }
            } else {
                let msg = error?.localizedDescription ?? "HTTP \(status)"
                log.error("upload failed \(key): \(msg)")
                await LocalStore.shared.updateSegment(meetingId: info.meetingId, seq: info.seq) { $0.uploadState = .failed; $0.lastError = msg }
                eventContinuation.yield(Event(meetingId: info.meetingId, seq: info.seq, state: .failed))
                // Повтор с задержкой (presigned URL мог истечь — запросим новый)
                let attempts = await LocalStore.shared.meeting(info.meetingId)?.segments.first { $0.seq == info.seq }?.attempts ?? 1
                let delay = min(60, pow(2, Double(attempts))) 
                try? await Task.sleep(for: .seconds(delay))
                await kick()
            }
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [weak self] in
            self?.backgroundCompletionHandler?()
            self?.backgroundCompletionHandler = nil
        }
    }
}
