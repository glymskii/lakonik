import Foundation

// DTO, зеркалящие OpenAPI сервера (apps/server/src/api/schemas.ts)

struct APIErrorBody: Decodable {
    let error: String
    let code: String?
}

struct TemplateField: Codable, Hashable, Identifiable {
    var id: String { key }
    let key: String
    let label: String
    let hint: String?
    let type: String?
    let askBeforeRecording: Bool?
}

struct TemplateSection: Codable, Hashable, Identifiable {
    var id: String { key }
    let key: String
    let heading: String
    let kind: String
    let guidance: String?
    let internalOnly: Bool?
}

struct MeetingTemplate: Codable, Hashable, Identifiable {
    let id: String
    let code: String
    let version: Int
    let group: String
    let category: String
    let title: String
    let subtitle: String?
    let goal: String
    let reportTitle: String
    let emoji: String
    let color: String
    let confidentiality: String
    let allowConfidentialityChoice: Bool
    let slaHours: Int
    let sendTo: String?
    let commonFields: [TemplateField]
    let specificFields: [TemplateField]
    let reportSections: [TemplateSection]
    let tips: [String]
    let isDraft: Bool
    let sortOrder: Int

    var isRestricted: Bool { confidentiality == "restricted" }
}

struct TemplateGroup: Codable, Hashable, Identifiable {
    var id: String { code }
    let code: String
    let title: String
    let subtitle: String
    let emoji: String
    let color: String
    let order: Int
}

struct TemplateCategory: Codable, Hashable, Identifiable {
    var id: String { code }
    let code: String
    let title: String
    let order: Int
}

struct TemplatesResponse: Codable {
    let groups: [TemplateGroup]
    let categories: [TemplateCategory]
    let templates: [MeetingTemplate]
}

struct Participant: Codable, Hashable, Identifiable {
    var id: String { name + (role ?? "") + (company ?? "") }
    var name: String
    var role: String?
    var company: String?
    var side: String?
}

struct Marker: Codable, Hashable, Identifiable {
    var id: String { createdAt }
    let atSec: Double
    let note: String?
    let createdAt: String
}

enum MeetingStatus: String, Codable {
    case recording, uploading, queued, processing, transcribing, transcribed, summarizing, done, failed

    var title: String {
        switch self {
        case .recording: return "Идёт запись"
        case .uploading: return "Загрузка"
        case .queued: return "В очереди"
        case .processing: return "Подготовка аудио"
        case .transcribing: return "Транскрибация"
        case .transcribed: return "Расшифровка готова"
        case .summarizing: return "Составление отчёта"
        case .done: return "Готово"
        case .failed: return "Ошибка"
        }
    }

    var isInProgress: Bool { [.queued, .processing, .transcribing, .summarizing, .uploading].contains(self) }
}

/// Значение поля контекста: строка, список строк, число или null
enum ContextValue: Codable, Hashable {
    case string(String)
    case list([String])
    case number(Double)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let l = try? c.decode([String].self) { self = .list(l); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Неизвестный тип ContextValue")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .list(let l): try c.encode(l)
        case .number(let n): try c.encode(n)
        case .null: try c.encodeNil()
        }
    }

    var displayText: String {
        switch self {
        case .string(let s): return s
        case .list(let l): return l.joined(separator: ", ")
        case .number(let n): return n.formatted()
        case .null: return ""
        }
    }
}

struct MeetingSummary: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let status: MeetingStatus
    let statusDetail: String?
    let error: String?
    let templateId: String
    let templateCode: String
    let templateTitle: String
    let templateEmoji: String
    let group: String
    let source: String
    let confidentiality: String
    let startedAt: Date
    let endedAt: Date?
    let durationSec: Int?
    let segmentCount: Int
    let hasTranscript: Bool
    let hasReport: Bool
    let isOwner: Bool
    let createdAt: Date
    let updatedAt: Date
}

struct MeetingsPage: Codable {
    let items: [MeetingSummary]
    let total: Int
}

struct TranscriptSegment: Codable, Hashable, Identifiable {
    var id: String { "\(start)-\(speakerId)" }
    let start: Double
    let end: Double
    let speakerId: String
    let text: String
}

/// Предположение ИИ о спикере после расшифровки — пользователь подтверждает или меняет
struct SpeakerSuggestion: Codable, Hashable, Identifiable {
    let speakerId: String
    let name: String?
    let role: String?
    let company: String?
    let side: String // ours | client | vendor | unknown
    let confidence: String // high | medium | low
    let evidence: String?
    /// id другого спикера, если это, скорее всего, тот же человек (дубль диаризации)
    let sameAs: String?
    var id: String { speakerId }

    var sideRole: SpeakerRole? { SpeakerRole(rawValue: side) }
    var confidenceTitle: String {
        switch confidence {
        case "high": return "уверенно"
        case "medium": return "вероятно"
        default: return "неуверенно"
        }
    }
}

struct SpeakerSuggestions: Codable, Hashable {
    let estimatedSpeakerCount: Int
    let speakers: [SpeakerSuggestion]
    let notes: String?
    let model: String
    let createdAt: String

    func suggestion(for speakerId: String) -> SpeakerSuggestion? { speakers.first { $0.speakerId == speakerId } }
}

struct Transcript: Codable, Hashable {
    let id: String
    let provider: String
    let languageCode: String?
    let segments: [TranscriptSegment]
    let speakers: [String: String]
    let selfSpeakerId: String?
    let speakerRoles: [String: SpeakerRole]
    let speakerIds: [String]
    var speakerSuggestions: SpeakerSuggestions? = nil
    var speakersConfirmed: Bool = false
    let audioDurationSec: Double?
    let wordCount: Int
    let createdAt: Date

    /// Подпись спикера: имя → «Клиент N» / «Вендор N» (нумерация внутри роли по порядку speaker_id) → «Спикер N»
    func label(for speakerId: String) -> String {
        if let custom = speakers[speakerId], !custom.trimmingCharacters(in: .whitespaces).isEmpty { return custom }
        if let role = speakerRoles[speakerId], role != .ours {
            let sameRole = speakerRoles.filter { $0.value == role }.map(\.key).sorted { Self.index($0) < Self.index($1) }
            let n = (sameRole.firstIndex(of: speakerId) ?? 0) + 1
            return "\(role.title) \(n)"
        }
        return "Спикер \(Self.index(speakerId) + 1)"
    }

    static func index(_ speakerId: String) -> Int { Int(speakerId.filter(\.isNumber)) ?? 0 }
}

enum SpeakerRole: String, Codable, CaseIterable {
    case ours, client, vendor
    var title: String {
        switch self { case .ours: return "Коллега"; case .client: return "Клиент"; case .vendor: return "Вендор" }
    }
    var icon: String {
        switch self { case .ours: return "person.crop.circle"; case .client: return "person.crop.circle.badge.questionmark"; case .vendor: return "shippingbox" }
    }
}

struct AccountUser: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let email: String
    let agencyId: String?
    let agencyName: String?
    var displayName: String { name.trimmingCharacters(in: .whitespaces).isEmpty ? email : name }
}

struct ActionItem: Codable, Hashable, Identifiable {
    var id: String { task + (assignee ?? "") }
    var assignee: String?
    var task: String
    var deadline: String?
    var quote: String?
    var done: Bool?
}

struct Decision: Codable, Hashable, Identifiable {
    var id: String { decision }
    let decision: String
    let owner: String?
    let deadline: String?
}

struct NextMeeting: Codable, Hashable {
    let when: String?
    let format: String?
    let agenda: String?
}

struct RenderedTable: Codable, Hashable {
    let columns: [String]
    let rows: [[String]]
}

struct RenderedSection: Codable, Hashable, Identifiable {
    var id: String { key }
    let key: String
    let heading: String
    let kind: String
    let internalOnly: Bool
    let content: String
    let table: RenderedTable?
    let items: [String]?
}

struct Report: Codable, Hashable, Identifiable {
    let id: String
    let version: Int
    let templateId: String
    let templateCode: String
    let reportTitle: String
    let model: String
    let effort: String?
    let title: String
    let summary: String
    let participants: [Participant]
    let sections: [RenderedSection]
    var actionItems: [ActionItem]
    let decisions: [Decision]
    let openQuestions: [String]
    let clientRequests: [String]
    let missingInfo: [String]
    let nextMeeting: NextMeeting?
    let markdown: String
    let createdBy: String
    let createdAt: Date
    let editedAt: Date?
}

struct ReportEditBody: Encodable {
    struct Section: Encodable { let key: String; let content: String }
    var title: String?
    var summary: String?
    var sections: [Section]?
    var participants: [Participant]?
    var decisions: [Decision]?
    var openQuestions: [String]?
    var clientRequests: [String]?
    var missingInfo: [String]?
}

struct ReportVersion: Codable, Hashable, Identifiable {
    let id: String
    let version: Int
    let templateCode: String
    let createdAt: Date
    let createdBy: String
    let instructions: String?
}

struct MeetingDetail: Codable, Hashable, Identifiable {
    let tasks: [TaskItem]
    let reportDueAt: Date
    let reportSlaHours: Int
    let id: String
    let title: String
    let status: MeetingStatus
    let statusDetail: String?
    let error: String?
    let templateId: String
    let templateCode: String
    let templateTitle: String
    let templateEmoji: String
    let group: String
    let source: String
    let confidentiality: String
    let startedAt: Date
    let endedAt: Date?
    let durationSec: Int?
    let segmentCount: Int
    let hasTranscript: Bool
    let hasReport: Bool
    let isOwner: Bool
    let createdAt: Date
    let updatedAt: Date
    let contextFields: [String: ContextValue]
    let participantsHint: [Participant]
    let numSpeakersHint: Int?
    let languageHint: String?
    let platform: String?
    let markers: [Marker]
    let transcript: Transcript?
    let report: Report?
    let reportVersions: [ReportVersion]

    var summary: MeetingSummary {
        MeetingSummary(id: id, title: title, status: status, statusDetail: statusDetail, error: error, templateId: templateId, templateCode: templateCode, templateTitle: templateTitle, templateEmoji: templateEmoji, group: group, source: source, confidentiality: confidentiality, startedAt: startedAt, endedAt: endedAt, durationSec: durationSec, segmentCount: segmentCount, hasTranscript: hasTranscript, hasReport: hasReport, isOwner: isOwner, createdAt: createdAt, updatedAt: updatedAt)
    }

    func with(tasks: [TaskItem]) -> MeetingDetail {
        MeetingDetail(tasks: tasks, reportDueAt: reportDueAt, reportSlaHours: reportSlaHours, id: id, title: title, status: status, statusDetail: statusDetail, error: error, templateId: templateId, templateCode: templateCode, templateTitle: templateTitle, templateEmoji: templateEmoji, group: group, source: source, confidentiality: confidentiality, startedAt: startedAt, endedAt: endedAt, durationSec: durationSec, segmentCount: segmentCount, hasTranscript: hasTranscript, hasReport: hasReport, isOwner: isOwner, createdAt: createdAt, updatedAt: updatedAt, contextFields: contextFields, participantsHint: participantsHint, numSpeakersHint: numSpeakersHint, languageHint: languageHint, platform: platform, markers: markers, transcript: transcript, report: report, reportVersions: reportVersions)
    }
}

// MARK: - Задачи / люди / настройки сроков

enum TaskStatus: String, Codable { case open, done }

struct TaskItem: Codable, Hashable, Identifiable {
    let id: String
    let meetingId: String
    let meetingTitle: String
    let meetingEmoji: String
    let meetingStartedAt: Date
    var task: String
    var assigneeName: String?
    var assigneePersonId: String?
    var deadlineText: String?
    var deadlineDate: String?
    var deadlineIsDefault: Bool
    let quote: String?
    var status: TaskStatus
    let doneAt: Date?
    let source: String
    let isOwner: Bool
    let createdAt: Date

    var isDone: Bool { status == .done }
    var deadline: Date? { deadlineDate.flatMap { DateOnly.parse($0) } }
    var isOverdue: Bool { !isDone && (deadline.map { $0 < DateOnly.startOfToday } ?? false) }
}

struct TaskPatch: Encodable {
    var task: String?
    var status: TaskStatus?
    var assigneePersonId: String??
    var assigneeName: String??
    var deadlineDate: String??
    var deadlineText: String??

    enum CodingKeys: String, CodingKey { case task, status, assigneePersonId, assigneeName, deadlineDate, deadlineText }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let task { try c.encode(task, forKey: .task) }
        if let status { try c.encode(status, forKey: .status) }
        if let v = assigneePersonId { try c.encode(v, forKey: .assigneePersonId) }
        if let v = assigneeName { try c.encode(v, forKey: .assigneeName) }
        if let v = deadlineDate { try c.encode(v, forKey: .deadlineDate) }
        if let v = deadlineText { try c.encode(v, forKey: .deadlineText) }
    }
}

struct TaskCreate: Encodable {
    var task: String
    var assigneePersonId: String?
    var assigneeName: String?
    var deadlineDate: String?
}

struct TasksPage: Decodable {
    let items: [TaskItem]
    let openCount: Int
    let overdueCount: Int
}

struct Person: Codable, Hashable, Identifiable {
    let id: String
    var name: String
    var role: String?
    var company: String?
    var email: String?
    let agencyId: String?
    let source: String
    var isActive: Bool
    let openTasks: Int?

    var subtitle: String { [role, company].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
}

struct PersonBody: Encodable {
    var name: String
    var role: String?
    var company: String?
    var email: String?
    var isActive: Bool?
}

struct DeadlineSettings: Codable, Hashable {
    var defaultTaskDeadlineDays: Int
    var workingDaysOnly: Bool
    var remindDaysBefore: Int
    var remindHourLocal: Int
    var reportSlaInternalHours: Int
    var reportSlaExternalHours: Int
}

/// Работа с датами вида YYYY-MM-DD (сроки задач) в календаре пользователя
enum DateOnly {
    static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static func parse(_ s: String) -> Date? { formatter.date(from: s) }
    static func string(_ d: Date) -> String { formatter.string(from: d) }
    static var startOfToday: Date { Calendar.current.startOfDay(for: Date()) }
    static let display: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.dateFormat = "d MMM yyyy"
        return f
    }()
    static func display(_ s: String?) -> String? { s.flatMap(parse).map { display.string(from: $0) } }
}

struct CreateMeetingBody: Encodable {
    /// nil — быстрая запись: тип встречи выбирается во время записи или после расшифровки
    var templateId: String?
    var title: String?
    var source: String = "recorded"
    var startedAt: String?
    var contextFields: [String: ContextValue] = [:]
    var participantsHint: [Participant] = []
    var numSpeakersHint: Int?
    var languageHint: String?
    var platform: String?
    var confidentiality: String?
    var deviceId: String?
}

struct UpdateMeetingBody: Encodable {
    var templateId: String?
    var title: String?
    var contextFields: [String: ContextValue]?
    var participantsHint: [Participant]?
    var numSpeakersHint: Int?
    var languageHint: String?
    var platform: String?
    var markers: [Marker]?
    var confidentiality: String?
}

struct SegmentRequestBody: Encodable {
    var seq: Int
    var contentType: String = "audio/mp4"
    var kind: String = "segment"
    var fileExtension: String = "m4a"

    enum CodingKeys: String, CodingKey { case seq, contentType, kind, fileExtension = "extension" }
}

struct SegmentUpload: Decodable {
    let seq: Int
    let objectKey: String
    let uploadUrl: String
    let expiresInSec: Int
    let headers: [String: String]
}

struct SegmentCompleteBody: Encodable {
    var durationSec: Double?
    var sizeBytes: Int?
}

struct FinalizeBody: Encodable {
    var endedAt: String?
    var durationSec: Int?
    var markers: [Marker]?
}

struct SpeakersBody: Encodable {
    let speakers: [String: String]
    var selfSpeakerId: String?? = nil
    var speakerRoles: [String: SpeakerRole]? = nil
    /// Слияние дублей диаризации: { "speaker_5": "speaker_2" }
    var merges: [String: String]? = nil
    /// Пользователь проверил спикеров после расшифровки
    var confirmed: Bool? = nil
    enum CodingKeys: String, CodingKey { case speakers, selfSpeakerId, speakerRoles, merges, confirmed }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(speakers, forKey: .speakers)
        try c.encodeIfPresent(merges, forKey: .merges)
        try c.encodeIfPresent(confirmed, forKey: .confirmed)
        if let v = selfSpeakerId { try c.encode(v, forKey: .selfSpeakerId) }
        if let r = speakerRoles { try c.encode(r, forKey: .speakerRoles) }
    }
}
struct UpdateUserBody: Encodable { let name: String }
struct RegenerateBody: Encodable { var templateId: String?; var effort: String?; var draft: Bool?; var instructions: String? }
struct ActionItemsBody: Encodable { let actionItems: [ActionItem] }
struct ShareBody: Encodable { let email: String; var scope: String = "report" }
struct Share: Decodable, Identifiable { let id: String; let recipientEmail: String; let scope: String; let createdAt: Date }
struct DeviceBody: Encodable { let platform: String; let pushToken: String; let appVersion: String? }

struct Me: Codable, Hashable {
    let id: String
    let email: String
    let name: String
    let image: String?
    let role: String
    let agencyId: String?
    let agencyName: String?
}

struct OTPSendBody: Encodable { let email: String; let type: String }
struct OTPVerifyBody: Encodable { let email: String; let otp: String }
struct AuthUser: Decodable { let id: String; let email: String; let name: String? }
struct OTPVerifyResponse: Decodable { let token: String; let user: AuthUser }
struct SocialIdToken: Encodable { let token: String; var nonce: String?; var accessToken: String? }
struct SocialSignInBody: Encodable { let provider: String; let idToken: SocialIdToken }

struct StatusEvent: Decodable {
    let status: MeetingStatus
    let statusDetail: String?
    let error: String?
    let updatedAt: Date
}
