import AVFoundation
import Foundation
import Observation
import UIKit
import os

/// Завершённые трансляции (записи онлайн-встреч) → сведение двух треков в один m4a → импорт как обычной записи.
@Observable
@MainActor
final class BroadcastImporter {
    static let shared = BroadcastImporter()

    private let log = Logger(subsystem: "kz.adv.meetings", category: "broadcast-import")
    private(set) var importing: String?
    private(set) var lastError: String?
    private var busy = false

    /// Проверить контейнер App Group и отправить все готовые записи. Вызывается при активации приложения и с экрана онлайн-встречи.
    func importFinished() async {
        guard !busy, !RecordingCoordinator.shared.isActive else { return }
        busy = true
        defer { busy = false }
        for m in BroadcastStore.all() where !m.imported {
            switch m.state {
            case .recording:
                // Расширение перестало обновлять манифест (убито системой) — считаем запись законченной
                if Date().timeIntervalSince(m.heartbeatAt) > 30 { await importSession(m) }
            case .finished:
                await importSession(m)
            case .failed:
                lastError = m.error
                BroadcastStore.remove(m.id)
            }
        }
    }

    private func importSession(_ m: BroadcastManifest) async {
        importing = m.id
        defer { importing = nil }
        guard let dir = BroadcastStore.sessionDir(m.id) else { return }
        let appURL = dir.appending(path: m.appFile)
        let micURL = dir.appending(path: m.micFile)
        do {
            let mixed = try await mix(app: m.hasAppAudio ? appURL : nil, appStart: m.appStartSec, mic: m.hasMicAudio ? micURL : nil, micStart: m.micStartSec, id: m.id)
            let title = "Онлайн-встреча \(m.startedAt.formatted(.dateTime.day(.twoDigits).month(.twoDigits).year().hour().minute().locale(Locale(identifier: "ru_RU"))))"
            let created = try await APIClient.shared.createMeeting(CreateMeetingBody(templateId: nil, title: title, source: "imported", startedAt: ISO8601DateFormatter.fractional.string(from: m.startedAt), platform: "Онлайн-встреча", deviceId: UIDevice.current.identifierForVendor?.uuidString))
            try await RecordingCoordinator.shared.importFile(mixed, serverMeeting: created, template: nil)
            var done = m
            done.imported = true
            BroadcastStore.save(done)
            BroadcastStore.remove(m.id)
            try? FileManager.default.removeItem(at: mixed)
            lastError = nil
            log.info("broadcast \(m.id) imported as meeting \(created.id)")
        } catch {
            log.error("import failed \(m.id): \(error.localizedDescription)")
            lastError = "Не удалось отправить запись онлайн-встречи: \(error.localizedDescription)"
        }
    }

    /// Сведение треков: звук приложения и микрофон выравниваются по времени первого буфера и микшируются в один моно-файл AAC
    private func mix(app: URL?, appStart: Double?, mic: URL?, micStart: Double?, id: String) async throws -> URL {
        let composition = AVMutableComposition()
        var tracks: [(URL, Double)] = []
        if let app { tracks.append((app, appStart ?? 0)) }
        if let mic { tracks.append((mic, micStart ?? 0)) }
        guard !tracks.isEmpty else { throw NSError(domain: "Broadcast", code: 1, userInfo: [NSLocalizedDescriptionKey: "В записи нет звука"]) }
        let base = tracks.map(\.1).min() ?? 0
        for (url, start) in tracks {
            let asset = AVURLAsset(url: url)
            guard let src = try await asset.loadTracks(withMediaType: .audio).first else { continue }
            let duration = try await asset.load(.duration)
            guard let dst = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
            try dst.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: src, at: CMTime(seconds: max(0, start - base), preferredTimescale: 600))
        }
        guard !composition.tracks.isEmpty else { throw NSError(domain: "Broadcast", code: 2, userInfo: [NSLocalizedDescriptionKey: "Не удалось прочитать аудио трансляции"]) }
        let out = URL.temporaryDirectory.appending(path: "broadcast-\(id).m4a")
        try? FileManager.default.removeItem(at: out)
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
            throw NSError(domain: "Broadcast", code: 3, userInfo: [NSLocalizedDescriptionKey: "Экспорт аудио недоступен"])
        }
        export.outputURL = out
        export.outputFileType = .m4a
        await export.export()
        if let e = export.error { throw e }
        guard export.status == .completed else { throw NSError(domain: "Broadcast", code: 4, userInfo: [NSLocalizedDescriptionKey: "Экспорт не завершился (статус \(export.status.rawValue))"]) }
        return out
    }
}
