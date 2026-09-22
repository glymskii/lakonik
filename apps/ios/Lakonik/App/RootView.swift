import SwiftUI

struct RootView: View {
    @Environment(AuthService.self) private var auth
    @Environment(RecordingCoordinator.self) private var recorder

    var body: some View {
        Group {
            if auth.isSignedIn {
                MainTabs()
                    .task { await auth.refreshMe() }
            } else {
                SignInView()
            }
        }
        .fullScreenCover(isPresented: Binding(get: { recorder.isPresentingRecorder }, set: { recorder.isPresentingRecorder = $0 })) {
            RecordingView()
        }
    }
}

struct MainTabs: View {
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            MeetingsListView()
                .tabItem { Label("Встречи", systemImage: "waveform.circle") }
                .tag(0)
            TasksView()
                .tabItem { Label("Задачи", systemImage: "checklist") }
                .tag(1)
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "gearshape") }
                .tag(2)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openTasksTab)) { _ in tab = 1 }
    }
}

extension Notification.Name {
    static let openTasksTab = Notification.Name("kz.adv.meetings.openTasksTab")
    /// Список встреч на сервере изменился не из списка (отмена записи, чистка оборванных записей при старте)
    static let meetingsChanged = Notification.Name("kz.adv.meetings.meetingsChanged")
}
