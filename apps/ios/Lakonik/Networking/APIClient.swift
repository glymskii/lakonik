import Foundation
import os

enum APIError: LocalizedError {
    case unauthorized
    case server(status: Int, message: String)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Требуется вход"
        case .server(_, let message): return message
        case .network(let e): return "Нет связи с сервером: \(e.localizedDescription)"
        case .decoding: return "Не удалось разобрать ответ сервера"
        }
    }
}

/// Тонкий HTTP-клиент к API: JSON, bearer-токен, ISO-8601 даты.
final class APIClient {
    static let shared = APIClient()

    private let log = Logger(subsystem: "kz.adv.meetings", category: "api")
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    var tokenProvider: () -> String? = { Keychain.shared.token }
    var onUnauthorized: (() -> Void)?

    /// Сессия без cookie: аутентификация только по bearer-токену. Иначе URLSession сохраняет cookie сессии
    /// Better Auth и с ними сервер требует заголовок Origin (403 «Missing or null Origin»).
    static func makeSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.httpCookieStorage = nil
        cfg.timeoutIntervalForRequest = 60
        cfg.waitsForConnectivity = true
        return URLSession(configuration: cfg)
    }

    init(session: URLSession = APIClient.makeSession()) {
        self.session = session
        // Подчистить cookie, сохранённые прежними версиями
        HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { d in
            let c = try d.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = ISO8601DateFormatter.fractional.date(from: s) ?? ISO8601DateFormatter.plain.date(from: s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Bad date \(s)")
        }
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    var baseURL: URL { AppConfig.apiBaseURL }

    func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, auth: Bool = true) async throws -> T {
        let data = try await raw(method, path, query: query, body: body, auth: auth)
        do { return try decoder.decode(T.self, from: data) } catch {
            log.error("decode \(path): \(error)")
            throw APIError.decoding(error)
        }
    }

    @discardableResult
    func raw(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, auth: Bool = true, accept: String = "application/json") async throws -> Data {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.setValue(accept, forHTTPHeaderField: "Accept")
        if auth, let token = tokenProvider() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(AnyEncodable(body))
        }
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) } catch { throw APIError.network(error) }
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if status == 401 {
            onUnauthorized?()
            throw APIError.unauthorized
        }
        guard (200..<300).contains(status) else {
            let msg = (try? decoder.decode(APIErrorBody.self, from: data))?.error ?? "Ошибка сервера (\(status))"
            log.error("\(method) \(path) -> \(status): \(msg)")
            throw APIError.server(status: status, message: msg)
        }
        return data
    }

    /// PUT файла на presigned URL (для маленьких файлов / тестов; основная загрузка — фоновая URLSession)
    func putFile(url: URL, fileURL: URL, contentType: String) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (_, resp) = try await session.upload(for: req, fromFile: fileURL)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError.server(status: status, message: "Загрузка не удалась (\(status))") }
    }
}

private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - Эндпоинты

extension APIClient {
    func sendOTP(email: String) async throws {
        try await raw("POST", "/api/auth/email-otp/send-verification-otp", body: OTPSendBody(email: email, type: "sign-in"), auth: false)
    }

    func verifyOTP(email: String, otp: String) async throws -> OTPVerifyResponse {
        try await request("POST", "/api/auth/sign-in/email-otp", body: OTPVerifyBody(email: email, otp: otp), auth: false)
    }

    func socialSignIn(provider: String, idToken: String, nonce: String? = nil, accessToken: String? = nil) async throws -> OTPVerifyResponse {
        try await request("POST", "/api/auth/sign-in/social", body: SocialSignInBody(provider: provider, idToken: SocialIdToken(token: idToken, nonce: nonce, accessToken: accessToken)), auth: false)
    }

    func signOut() async throws { try await raw("POST", "/api/auth/sign-out", body: EmptyBody()) }
    func me() async throws -> Me { try await request("GET", "/api/me") }
    func registerDevice(_ body: DeviceBody) async throws { try await raw("POST", "/api/me/devices", body: body) }

    func templates() async throws -> TemplatesResponse { try await request("GET", "/api/templates") }

    func meetings(query: String? = nil, limit: Int = 50, offset: Int = 0) async throws -> MeetingsPage {
        var q = [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        if let query, !query.isEmpty { q.append(URLQueryItem(name: "q", value: query)) }
        return try await request("GET", "/api/meetings", query: q)
    }

    func createMeeting(_ body: CreateMeetingBody) async throws -> MeetingSummary { try await request("POST", "/api/meetings", body: body) }
    func meeting(_ id: String) async throws -> MeetingDetail { try await request("GET", "/api/meetings/\(id)") }
    func updateMeeting(_ id: String, _ body: UpdateMeetingBody) async throws -> MeetingDetail { try await request("PATCH", "/api/meetings/\(id)", body: body) }
    func deleteMeeting(_ id: String) async throws { try await raw("DELETE", "/api/meetings/\(id)") }

    func requestSegmentUpload(meetingId: String, seq: Int, kind: String = "segment", contentType: String = "audio/mp4", ext: String = "m4a") async throws -> SegmentUpload {
        try await request("POST", "/api/meetings/\(meetingId)/segments", body: SegmentRequestBody(seq: seq, contentType: contentType, kind: kind, fileExtension: ext))
    }
    func completeSegment(meetingId: String, seq: Int, durationSec: Double?, sizeBytes: Int?) async throws {
        try await raw("POST", "/api/meetings/\(meetingId)/segments/\(seq)/complete", body: SegmentCompleteBody(durationSec: durationSec, sizeBytes: sizeBytes))
    }
    func finalize(meetingId: String, body: FinalizeBody) async throws -> MeetingSummary { try await request("POST", "/api/meetings/\(meetingId)/finalize", body: body) }
    func retry(meetingId: String) async throws -> MeetingSummary { try await request("POST", "/api/meetings/\(meetingId)/retry", body: EmptyBody()) }
    func renameSpeakers(meetingId: String, speakers: [String: String], selfSpeakerId: String?? = nil, speakerRoles: [String: SpeakerRole]? = nil, merges: [String: String]? = nil, confirmed: Bool? = nil) async throws -> MeetingDetail {
        try await request("PATCH", "/api/meetings/\(meetingId)/speakers", body: SpeakersBody(speakers: speakers, selfSpeakerId: selfSpeakerId, speakerRoles: speakerRoles, merges: merges, confirmed: confirmed))
    }
    func users(query: String? = nil) async throws -> [AccountUser] {
        var q: [URLQueryItem] = []
        if let query, !query.isEmpty { q.append(URLQueryItem(name: "q", value: query)) }
        return try await request("GET", "/api/users", query: q)
    }
    func updateUserName(_ name: String) async throws { try await raw("POST", "/api/auth/update-user", body: UpdateUserBody(name: name)) }
    func regenerate(meetingId: String, body: RegenerateBody) async throws -> MeetingSummary { try await request("POST", "/api/meetings/\(meetingId)/reports", body: body) }
    func updateActionItems(meetingId: String, reportId: String, items: [ActionItem]) async throws -> Report {
        try await request("PATCH", "/api/meetings/\(meetingId)/reports/\(reportId)/action-items", body: ActionItemsBody(actionItems: items))
    }
    func editReport(meetingId: String, reportId: String, _ body: ReportEditBody) async throws -> Report {
        try await request("PATCH", "/api/meetings/\(meetingId)/reports/\(reportId)", body: body)
    }
    func export(meetingId: String, format: String) async throws -> Data {
        try await raw("GET", "/api/meetings/\(meetingId)/export", query: [URLQueryItem(name: "format", value: format)], accept: "*/*")
    }
    func shares(meetingId: String) async throws -> [Share] { try await request("GET", "/api/meetings/\(meetingId)/shares") }
    func share(meetingId: String, email: String, scope: String) async throws -> Share { try await request("POST", "/api/meetings/\(meetingId)/shares", body: ShareBody(email: email, scope: scope)) }
    func unshare(meetingId: String, shareId: String) async throws { try await raw("DELETE", "/api/meetings/\(meetingId)/shares/\(shareId)") }

    // Задачи
    func tasks(status: String = "open", assignee: String? = nil, meetingId: String? = nil, query: String? = nil) async throws -> TasksPage {
        var q = [URLQueryItem(name: "status", value: status), URLQueryItem(name: "limit", value: "500")]
        if let assignee { q.append(URLQueryItem(name: "assignee", value: assignee)) }
        if let meetingId { q.append(URLQueryItem(name: "meetingId", value: meetingId)) }
        if let query, !query.isEmpty { q.append(URLQueryItem(name: "q", value: query)) }
        return try await request("GET", "/api/tasks", query: q)
    }
    func updateTask(_ id: String, _ patch: TaskPatch) async throws -> TaskItem { try await request("PATCH", "/api/tasks/\(id)", body: patch) }
    func deleteTask(_ id: String) async throws { try await raw("DELETE", "/api/tasks/\(id)") }
    func createTask(meetingId: String, _ body: TaskCreate) async throws -> TaskItem { try await request("POST", "/api/meetings/\(meetingId)/tasks", body: body) }

    // Люди
    func people(query: String? = nil, includeInactive: Bool = false) async throws -> [Person] {
        var q: [URLQueryItem] = [URLQueryItem(name: "includeInactive", value: includeInactive ? "1" : "0")]
        if let query, !query.isEmpty { q.append(URLQueryItem(name: "q", value: query)) }
        return try await request("GET", "/api/people", query: q)
    }
    func createPerson(_ body: PersonBody) async throws -> Person { try await request("POST", "/api/people", body: body) }
    func updatePerson(_ id: String, _ body: PersonBody) async throws -> Person { try await request("PATCH", "/api/people/\(id)", body: body) }
    func deletePerson(_ id: String) async throws { try await raw("DELETE", "/api/people/\(id)") }

    // Настройки сроков
    func deadlineSettings() async throws -> DeadlineSettings { try await request("GET", "/api/settings/deadlines") }
    func saveDeadlineSettings(_ s: DeadlineSettings) async throws -> DeadlineSettings { try await request("PUT", "/api/settings/deadlines", body: s) }

    /// SSE-поток статуса: возвращает события до done/failed
    func statusEvents(meetingId: String) -> AsyncThrowingStream<StatusEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var req = URLRequest(url: baseURL.appendingPathComponent("/api/meetings/\(meetingId)/events"))
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                if let token = tokenProvider() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                req.timeoutInterval = 60 * 35
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.server(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, message: "SSE недоступен") }
                    var dataBuf = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("data:") {
                            dataBuf += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        } else if line.isEmpty, !dataBuf.isEmpty {
                            if let d = dataBuf.data(using: .utf8), let ev = try? decoder.decode(StatusEvent.self, from: d) {
                                continuation.yield(ev)
                                if ev.status == .done || ev.status == .failed { break }
                            }
                            dataBuf = ""
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

struct EmptyBody: Encodable {}
