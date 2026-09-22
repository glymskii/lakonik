import Foundation
import Observation
import UIKit

@Observable
@MainActor
final class AuthService {
    private(set) var isSignedIn: Bool = Keychain.shared.token != nil
    private(set) var me: Me?
    var lastError: String?

    private let api = APIClient.shared

    init() {
        api.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.signOutLocally() }
        }
    }

    func sendCode(email: String) async throws {
        try await api.sendOTP(email: email.trimmingCharacters(in: .whitespaces).lowercased())
    }

    func verifyCode(email: String, code: String) async throws {
        let r = try await api.verifyOTP(email: email.trimmingCharacters(in: .whitespaces).lowercased(), otp: code)
        Keychain.shared.token = r.token
        isSignedIn = true
        await refreshMe()
    }

    func signInWithApple(idToken: String, nonce: String?) async throws {
        let r = try await api.socialSignIn(provider: "apple", idToken: idToken, nonce: nonce)
        Keychain.shared.token = r.token
        isSignedIn = true
        await refreshMe()
    }

    func updateName(_ name: String) async throws {
        try await api.updateUserName(name.trimmingCharacters(in: .whitespaces))
        await refreshMe()
    }

    func refreshMe() async {
        do {
            let m = try await api.me()
            me = m
            WorkspaceStore.shared.apply(me: m)
        } catch { lastError = error.localizedDescription }
    }

    func signOut() async {
        try? await api.signOut()
        signOutLocally()
    }

    func signOutLocally() {
        Keychain.shared.token = nil
        WorkspaceStore.shared.clear()
        AppConfig.clearOrg() // при выходе забываем корпоративный сервер: следующий вход снова спросит код организации
        me = nil
        isSignedIn = false
    }
}
