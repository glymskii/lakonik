import SwiftUI

/// Строка задачи: чекбокс, текст, ответственный, срок, встреча.
struct TaskRow: View {
    let task: TaskItem
    var showMeeting = true
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onToggle) {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.isDone ? .green : .secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.task)
                    .font(.subheadline)
                    .strikethrough(task.isDone)
                    .foregroundStyle(task.isDone ? .secondary : .primary)
                HStack(spacing: 10) {
                    Label(task.assigneeName ?? "не назначен", systemImage: "person")
                        .foregroundStyle(task.assigneeName == nil ? .orange : .secondary)
                    Label(deadlineLabel, systemImage: "calendar")
                        .foregroundStyle(deadlineColor)
                }
                .font(.caption)
                .lineLimit(1)
                if showMeeting {
                    Text("\(task.meetingEmoji) \(task.meetingTitle)")
                        .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var deadlineLabel: String {
        if let d = task.deadlineDate, let s = DateOnly.display(d) {
            return task.deadlineIsDefault ? "\(s) · по умолчанию" : s
        }
        return task.deadlineText ?? "без срока"
    }

    private var deadlineColor: Color {
        if task.isDone { return .secondary }
        if task.isOverdue { return .red }
        if task.deadlineDate == nil { return .orange }
        return task.deadlineIsDefault ? .secondary : .primary
    }
}
