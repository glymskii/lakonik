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
