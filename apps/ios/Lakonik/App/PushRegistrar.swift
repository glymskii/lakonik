import Foundation
import os
import UIKit
import UserNotifications

/// Регистрация push-уведомлений (APNs) и отправка токена на сервер.
final class PushRegistrar: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushRegistrar()
    private let log = Logger(subsystem: "kz.adv.meetings", category: "push")
    private(set) var token: String? = UserDefaults.standard.string(forKey: "apnsToken")
    /// Открыть встречу из уведомления
    var onOpenMeeting: ((String) -> Void)?

    func requestAuthorizationAndRegister() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didReceive(token: String) {
        self.token = token
        UserDefaults.standard.set(token, forKey: "apnsToken")
        Task { await sync() }
    }

    func didFail(_ error: Error) { log.error("APNs registration failed: \(error.localizedDescription)") }

    /// Отправить токен на сервер (после входа / при получении)
    func sync() async {
        guard let token, Keychain.shared.token != nil else { return }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        do { try await APIClient.shared.registerDevice(DeviceBody(platform: "ios", pushToken: token, appVersion: version)) } catch { log.error("device sync: \(error.localizedDescription)") }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        if info["kind"] as? String == "task_reminder" {
            await MainActor.run { NotificationCenter.default.post(name: .openTasksTab, object: nil) }
            return
        }
        if let id = info["meetingId"] as? String {
            await MainActor.run { onOpenMeeting?(id) }
        }
    }
}
