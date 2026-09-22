import Foundation
import os
import QuartzCore

/// Часы записи и огибающая сигнала для визуализации.
/// Время — медиа-часы (`CACurrentMediaTime`, та же база, что hostTime аудиобуферов) за вычетом пауз, поэтому столбики
/// осциллограммы, курсор и таймер живут в одной шкале. Пишет аудиопоток (окна по 50 мс), читает UI 60 раз в секунду.
final class LevelHistory: @unchecked Sendable {
    /// Сырое окно с аудиопотока: медиа-время начала, RMS и пик (линейные 0…1)
    struct Raw { let media: Double; let rms: Float; let peak: Float }
    /// Окно в шкале записи: секунды без пауз, RMS и пик нормированы по децибелам (−50 dBFS → 0, 0 dBFS → 1)
    struct Sample { let t: Double; let rms: Float; let peak: Float }

    static let window: Double = 0.05
    private static let maxSamples = 20 * 60 * 20 // 20 минут — для экрана записи достаточно

    private struct State {
        var samples: [Sample] = []
        var startMedia: Double?
        var pausedAccum: Double = 0
        var pauseStartedMedia: Double?
        var frozenAt: Double?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    func begin() { state.withLock { $0 = State(startMedia: CACurrentMediaTime()) } }

    func pause() {
        state.withLock { st in
            if st.pauseStartedMedia == nil, st.frozenAt == nil { st.pauseStartedMedia = CACurrentMediaTime() }
        }
    }

    func resume() {
        state.withLock { st in
            if let p = st.pauseStartedMedia { st.pausedAccum += CACurrentMediaTime() - p; st.pauseStartedMedia = nil }
        }
    }

    /// Останавливает часы: после стопа осциллограмма остаётся на экране до отправки
    func freeze() { state.withLock { st in st.frozenAt = Self.recordingTime(st, CACurrentMediaTime()) } }

    func clear() { state.withLock { $0 = State() } }

    /// Текущее время записи, с (без пауз)
    var now: Double { state.withLock { st in st.frozenAt ?? Self.recordingTime(st, CACurrentMediaTime()) } }

    /// Последний уровень (RMS 0…1) — для «дышащей» волны
    var latest: Float { state.withLock { $0.samples.last?.rms ?? 0 } }

    func append(_ raw: [Raw]) {
        state.withLock { st in
            guard st.startMedia != nil, st.pauseStartedMedia == nil, st.frozenAt == nil else { return }
            var lastT = st.samples.last?.t ?? -1
            for r in raw {
                let t = Self.recordingTime(st, r.media)
                guard t > lastT else { continue }
                st.samples.append(Sample(t: t, rms: Self.norm(r.rms), peak: Self.norm(r.peak)))
                lastT = t
            }
            if st.samples.count > Self.maxSamples + 2000 { st.samples.removeFirst(st.samples.count - Self.maxSamples) }
        }
    }

    /// Окна начиная с момента t0 (видимая часть осциллограммы)
    func samples(from t0: Double) -> [Sample] {
        state.withLock { st in
            var lo = 0, hi = st.samples.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if st.samples[mid].t < t0 { lo = mid + 1 } else { hi = mid }
            }
            return Array(st.samples[lo...])
        }
    }

    private static func recordingTime(_ st: State, _ media: Double) -> Double {
        guard let start = st.startMedia else { return 0 }
        let paused = st.pausedAccum + (st.pauseStartedMedia.map { max(0, media - $0) } ?? 0)
        return max(0, media - start - paused)
    }

    static func norm(_ v: Float) -> Float {
        let db = 20 * log10(max(v, 1e-6))
        return max(0, min(1, (db + 50) / 50))
    }
}
