import SwiftUI
import AuthenticationServices
import CryptoKit

@MainActor
struct SignInView: View {
    @Environment(AuthService.self) private var auth
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var error: String?
    @State private var appleNonce: String?
    @FocusState private var focus: Field?

    enum Field { case email, code }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer(minLength: 24)
                VStack(spacing: 8) {
                    Image(systemName: "waveform.badge.mic")
                        .font(.system(size: 56))
                        .foregroundStyle(.tint)
                    Text("Lakonik").font(.largeTitle.bold())
                    Text("Запись встреч → расшифровка → контакт-репорт")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }

                VStack(spacing: 12) {
                    TextField("Корпоративная почта", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .disabled(codeSent)
                        .padding(14)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))

                    if codeSent {
                        TextField("Код из письма (6 цифр)", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .focused($focus, equals: .code)
                            .padding(14)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                            .onChange(of: code) { _, v in
                                if v.count == 6 { Task { await verify() } }
                            }
                    }

                    Button {
                        Task { codeSent ? await verify() : await sendCode() }
                    } label: {
                        HStack {
                            if busy { ProgressView().tint(.white) }
                            Text(codeSent ? "Войти" : "Получить код")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || (codeSent ? code.count < 6 : !isValidEmail))

                    if codeSent {
                        Button("Изменить почту") { codeSent = false; code = ""; focus = .email }
                            .font(.footnote)
                    }
                }

                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }

                Divider().padding(.vertical, 4)

                SignInWithAppleButton(.signIn) { req in
                    let nonce = randomNonce()
                    appleNonce = nonce
                    req.requestedScopes = [.fullName, .email]
                    req.nonce = sha256(nonce)
                } onCompletion: { result in
                    Task { await handleApple(result) }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Text("Введите рабочую почту — код для входа придёт письмом.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Spacer()
            }
            .padding(24)
            .onAppear { focus = .email }
        }
    }

    private var isValidEmail: Bool {
        let e = email.trimmingCharacters(in: .whitespaces)
        return e.contains("@") && e.contains(".") && e.count > 5
    }

    private func sendCode() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            try await auth.sendCode(email: email)
            codeSent = true
            focus = .code
        } catch { self.error = error.localizedDescription }
    }

    private func verify() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await auth.verifyCode(email: email, code: code) } catch {
            self.error = error.localizedDescription
            code = ""
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let e):
            if (e as? ASAuthorizationError)?.code != .canceled { error = e.localizedDescription }
        case .success(let authz):
            guard let cred = authz.credential as? ASAuthorizationAppleIDCredential, let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8) else {
                error = "Apple не вернул токен"; return
            }
            busy = true; defer { busy = false }
            do { try await auth.signInWithApple(idToken: token, nonce: appleNonce) } catch { self.error = error.localizedDescription }
        }
    }

    private func randomNonce(length: Int = 32) -> String {
        let chars = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        for b in bytes { result.append(chars[Int(b) % chars.count]) }
        return result
    }

    private func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
