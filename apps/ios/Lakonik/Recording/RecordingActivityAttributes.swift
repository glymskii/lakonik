import ActivityKit
import Foundation

/// Live Activity на экране блокировки: таймер записи и кнопки пауза/стоп.
struct RecordingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Момент, от которого идёт таймер (сдвинут на время пауз)
        var timerStart: Date
        var isPaused: Bool
        var pausedElapsed: TimeInterval
        var uploadedSegments: Int
        var totalSegments: Int
    }

    var meetingId: String
    var title: String
    var templateEmoji: String
}
