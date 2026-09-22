import Sentry
import SwiftUI

@main
struct LakonikApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth = AuthService()
    @State private var store = TemplateStore()
    @State private var recorder = RecordingCoordinator.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .environment(store)
                .environment(recorder)
                .tint(Color("AccentColor"))
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Крэши и ошибки — только если в сборку передан DSN (SENTRY_DSN); содержимое встреч в события не попадает
        if let dsn = Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String, !dsn.isEmpty {
            SentrySDK.start { o in
                o.dsn = dsn
                o.environment = AppConfig.isDebug ? "development" : "production"
                o.tracesSampleRate = 0
                o.sendDefaultPii = false
                o.enableAutoSessionTracking = true
            }
        }
        UploadManager.shared.bootstrap()
        RecordingCoordinator.shared.bootstrap()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushRegistrar.shared.didReceive(token: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.shared.didFail(error)
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        UploadManager.shared.backgroundCompletionHandler = completionHandler
    }
}
