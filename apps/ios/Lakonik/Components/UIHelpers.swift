import SwiftUI

extension Color {
    /// Цвет группы шаблонов из API (red / blue / yellow / green)
    static func group(_ name: String) -> Color {
        switch name {
        case "red": return Color(red: 0.90, green: 0.30, blue: 0.26)
        case "blue": return Color(red: 0.20, green: 0.50, blue: 0.92)
        case "yellow": return Color(red: 0.95, green: 0.70, blue: 0.15)
        case "green": return Color(red: 0.22, green: 0.66, blue: 0.40)
        default: return .accentColor
        }
    }
}

enum Fmt {
    static func duration(_ sec: Int?) -> String {
        guard let sec, sec > 0 else { return "—" }
        if sec < 60 { return "\(sec) с" }
        let m = sec / 60
        if m < 60 { return "\(m) мин" }
        return "\(m / 60) ч \(m % 60) мин"
    }

    static func clock(_ t: TimeInterval) -> String {
        let s = Int(t.rounded(.down))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%02d:%02d", m, r)
    }

    static let dateTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.unitsStyle = .short
        return f
    }()
}

struct StatusBadge: View {
    let status: MeetingStatus
    var body: some View {
        HStack(spacing: 4) {
            if status.isInProgress { ProgressView().controlSize(.mini) }
            Image(systemName: icon).font(.caption2)
            Text(status.title).font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color)
    }
    private var icon: String {
        switch status {
        case .done: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .recording: return "record.circle"
        default: return "clock"
        }
    }
    private var color: Color {
        switch status {
        case .done: return .green
        case .failed: return .red
        case .recording: return .red
        default: return .orange
        }
    }
}

struct ErrorBanner: View {
    let message: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(message).font(.footnote)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }
}
