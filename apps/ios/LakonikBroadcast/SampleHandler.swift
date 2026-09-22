import AVFoundation
import ReplayKit
import os

/// Broadcast Upload Extension: iOS отдаёт сюда звук приложений (участники онлайн-встречи) и микрофон (ваш голос).
/// Пишем два AAC-трека в контейнер App Group; приложение сводит их и отправляет на обработку.
/// Видео-кадры не используем. Лимит памяти расширения ~50 МБ — поэтому только потоковая запись, без буферов.
final class SampleHandler: RPBroadcastSampleHandler {
    private let log = Logger(subsystem: "kz.adv.meetings", category: "broadcast")
    private let queue = DispatchQueue(label: "kz.adv.meetings.broadcast.writer", qos: .userInitiated)
    private var manifest: BroadcastManifest?
    private var app: TrackWriter?
    private var mic: TrackWriter?
    private var timer: DispatchSourceTimer?
    private var finished = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        BroadcastStore.stopRequested = false
        let id = UUID().uuidString
        guard let dir = BroadcastStore.sessionDir(id) else {
            finishBroadcastWithError(NSError(domain: "kz.adv.meetings", code: 1, userInfo: [NSLocalizedDescriptionKey: "Нет доступа к общему хранилищу приложения"]))
            return
        }
        var m = BroadcastManifest(id: id, startedAt: Date(), state: .recording, appFile: "app.m4a", micFile: "mic.m4a", heartbeatAt: Date())
        app = TrackWriter(url: dir.appending(path: m.appFile), bitrate: 96_000, log: log)
        mic = TrackWriter(url: dir.appending(path: m.micFile), bitrate: 64_000, log: log)
        m.heartbeatAt = Date()
        manifest = m
        BroadcastStore.save(m)
        log.info("broadcast started \(id)")

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .audioApp: queue.async { [weak self] in self?.app?.append(sampleBuffer) }
        case .audioMic: queue.async { [weak self] in self?.mic?.append(sampleBuffer) }
        default: break
        }
    }

    override func broadcastPaused() { log.info("broadcast paused") }
    override func broadcastResumed() { log.info("broadcast resumed") }

    override func broadcastFinished() {
        queue.sync { finalize(error: nil) }
    }

    /// Раз в секунду: heartbeat и длительность в манифест; по флагу из приложения — завершить трансляцию
    private func tick() {
        guard var m = manifest, !finished else { return }
        m.heartbeatAt = Date()
        m.appBuffers = app?.buffers ?? 0
        m.micBuffers = mic?.buffers ?? 0
        m.appStartSec = app?.firstPTS
        m.micStartSec = mic?.firstPTS
        m.durationSec = max(app?.durationSec ?? 0, mic?.durationSec ?? 0)
        manifest = m
        BroadcastStore.save(m)
        if BroadcastStore.stopRequested {
            BroadcastStore.stopRequested = false
            finalize(error: nil)
            // Единственный способ завершить трансляцию из расширения — finishBroadcastWithError; iOS покажет это сообщение
            finishBroadcastWithError(NSError(domain: "kz.adv.meetings", code: 0, userInfo: [NSLocalizedDescriptionKey: "Запись онлайн-встречи остановлена. Откройте приложение, чтобы отправить её на обработку."]))
        }
    }

    private func finalize(error: String?) {
        guard !finished, var m = manifest else { return }
        finished = true
        timer?.cancel()
        timer = nil
        app?.finish()
        mic?.finish()
        m.endedAt = Date()
        m.appBuffers = app?.buffers ?? 0
        m.micBuffers = mic?.buffers ?? 0
        m.appStartSec = app?.firstPTS
        m.micStartSec = mic?.firstPTS
        m.durationSec = max(app?.durationSec ?? 0, mic?.durationSec ?? 0)
        m.state = (m.appBuffers + m.micBuffers) > 0 && error == nil ? .finished : .failed
        m.error = error ?? ((m.appBuffers + m.micBuffers) == 0 ? "Звук не был получен: проверьте, что микрофон включён в диалоге трансляции" : nil)
        m.heartbeatAt = Date()
        manifest = m
        BroadcastStore.save(m)
        log.info("broadcast finished \(m.id): app=\(m.appBuffers) mic=\(m.micBuffers) dur=\(m.durationSec)")
    }
}

/// Потоковая запись одного аудиотрека в AAC. Формат выхода берём из первого буфера (частота, каналы) —
/// AVAssetWriterInput не пересчитывает частоту дискретизации, только кодирует.
final class TrackWriter {
    private let url: URL
    private let bitrate: Int
    private let log: Logger
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private(set) var firstPTS: Double?
    private var lastEnd: Double = 0
    private(set) var buffers = 0
    private var failed = false

    init(url: URL, bitrate: Int, log: Logger) {
        self.url = url
        self.bitrate = bitrate
        self.log = log
        try? FileManager.default.removeItem(at: url)
    }

    var durationSec: Double { firstPTS.map { max(0, lastEnd - $0) } ?? 0 }

    func append(_ sb: CMSampleBuffer) {
        guard !failed, CMSampleBufferDataIsReady(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if writer == nil {
            guard let fmt = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { return }
            do {
                let w = try AVAssetWriter(outputURL: url, fileType: .m4a)
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: asbd.mSampleRate,
                    AVNumberOfChannelsKey: Int(min(2, max(1, asbd.mChannelsPerFrame))),
                    AVEncoderBitRateKey: bitrate,
                ]
                let i = AVAssetWriterInput(mediaType: .audio, outputSettings: settings, sourceFormatHint: fmt)
                i.expectsMediaDataInRealTime = true
                guard w.canAdd(i) else { failed = true; return }
                w.add(i)
                guard w.startWriting() else { log.error("writer start failed: \(w.error?.localizedDescription ?? "?")"); failed = true; return }
                w.startSession(atSourceTime: pts)
                writer = w
                input = i
                firstPTS = pts.seconds
            } catch {
                log.error("writer init failed: \(error.localizedDescription)")
                failed = true
                return
            }
        }
        guard let input, input.isReadyForMoreMediaData else { return } // реальное время: отстающие буферы пропускаем
        if input.append(sb) {
            buffers += 1
            lastEnd = pts.seconds + CMSampleBufferGetDuration(sb).seconds
        } else if let e = writer?.error {
            log.error("append failed: \(e.localizedDescription)")
            failed = true
        }
    }

    func finish() {
        guard let writer, let input else { return }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        _ = done.wait(timeout: .now() + 10)
        if writer.status != .completed { log.error("finishWriting: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")") }
    }
}
