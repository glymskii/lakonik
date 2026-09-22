import AppIntents
import Foundation

/// Кнопки Live Activity (iOS 17+). Тип интента должен быть виден и приложению, и виджету;
/// perform() выполняется в процессе приложения (LiveActivityIntent), в виджете тело — заглушка.
struct PauseRecordingIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Пауза записи"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { RecordingCoordinator.shared.pause() }
        #endif
        return .result()
    }
}

struct ResumeRecordingIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Продолжить запись"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { RecordingCoordinator.shared.resume() }
        #endif
        return .result()
    }
}

struct StopRecordingIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Остановить запись"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await RecordingCoordinator.shared.stop()
        #endif
        return .result()
    }
}
