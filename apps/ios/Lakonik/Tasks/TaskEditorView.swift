import SwiftUI

/// Редактор задачи: текст, ответственный (справочник), срок, статус.
@MainActor
struct TaskEditorView: View {
    let task: TaskItem
    let onSaved: (TaskItem) async -> Void
    var onOpenMeeting: ((String) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var assignee: Person?
    @State private var assigneeName: String?
    @State private var hasDeadline: Bool
    @State private var deadline: Date
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false

    init(task: TaskItem, onSaved: @escaping (TaskItem) async -> Void, onOpenMeeting: ((String) -> Void)? = nil) {
        self.task = task
        self.onSaved = onSaved
        self.onOpenMeeting = onOpenMeeting
        _text = State(initialValue: task.task)
        _assigneeName = State(initialValue: task.assigneeName)
        _assignee = State(initialValue: task.assigneePersonId.map { Person(id: $0, name: task.assigneeName ?? "", role: nil, company: nil, email: nil, agencyId: nil, source: "", isActive: true, openTasks: nil) })
        _hasDeadline = State(initialValue: task.deadline != nil)
        _deadline = State(initialValue: task.deadline ?? Calendar.current.date(byAdding: .day, value: 7, to: Date())!)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Задача") {
                    TextField("Что нужно сделать", text: $text, axis: .vertical).lineLimit(2...6).disabled(!task.isOwner)
                    if let q = task.quote, !q.isEmpty {
                        Text("«\(q)»").font(.caption).italic().foregroundStyle(.secondary)
                    }
                }
                // Главное действие в карточке — отметить выполнение (доступно и тем, с кем встречей поделились)
                Section {
                    Button { Task { await setDone(!task.isDone) } } label: {
                        HStack {
                            if busy { ProgressView() } else { Image(systemName: task.isDone ? "arrow.uturn.backward.circle.fill" : "checkmark.circle.fill") }
                            Text(task.isDone ? "Вернуть в работу" : "Отметить выполненной").font(.headline)
                            Spacer()
                        }
                        .foregroundStyle(task.isDone ? Color.orange : Color.green)
                    }
                    .disabled(busy)
                    if task.isDone, let d = task.doneAt { Text("Выполнено \(Fmt.dateTime.string(from: d))").font(.caption).foregroundStyle(.secondary) }
                }
                Section("Ответственный") {
                    NavigationLink {
                        PeoplePickerView(selected: assignee) { person in
                            assignee = person
                            assigneeName = person?.name
                        }
                    } label: {
                        HStack {
                            Label(assigneeName ?? "Не назначен", systemImage: "person")
                            Spacer()
                            if assignee == nil, let n = assigneeName, !n.isEmpty { Text("не в справочнике").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                }
                Section {
                    Toggle("Срок", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Дата", selection: $deadline, displayedComponents: .date)
                            .environment(\.locale, Locale(identifier: "ru_RU"))
                        HStack(spacing: 8) {
                            quick("Завтра", days: 1); quick("Через 3 дня", days: 3); quick("Неделя", days: 7)
                        }
                    }
                } footer: {
                    if task.deadlineIsDefault && hasDeadline { Text("Срок назначен автоматически по настройкам (задача без явного срока на встрече)\(task.deadlineText.map { ". На встрече: «\($0)»" } ?? "")") }
                    else if let t = task.deadlineText, !t.isEmpty { Text("Как прозвучало на встрече: «\(t)»") }
                }
                Section("Встреча") {
                    Button {
                        onOpenMeeting?(task.meetingId)
                    } label: {
                        HStack {
                            Text("\(task.meetingEmoji) \(task.meetingTitle)").foregroundStyle(.primary)
                            Spacer()
                            Text(Fmt.dateTime.string(from: task.meetingStartedAt)).font(.caption).foregroundStyle(.secondary)
                            if onOpenMeeting != nil { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                        }
                    }
                    .disabled(onOpenMeeting == nil)
                }
                if task.isOwner {
                    Section { Button("Удалить задачу", role: .destructive) { confirmDelete = true } }
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .navigationTitle("Задача")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if task.isOwner {
                        Button("Сохранить") { Task { await save() } }.disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Удалить", role: .destructive) { Task { try? await APIClient.shared.deleteTask(task.id); await onSaved(task); dismiss() } }
            }
        }
    }

    private func quick(_ title: String, days: Int) -> some View {
        Button(title) { deadline = Calendar.current.date(byAdding: .day, value: days, to: DateOnly.startOfToday)! }
            .buttonStyle(.bordered).controlSize(.small).font(.caption)
    }

    /// Мгновенно меняет статус и закрывает карточку
    private func setDone(_ done: Bool) async {
        busy = true; defer { busy = false }
        do {
            let updated = try await APIClient.shared.updateTask(task.id, TaskPatch(status: done ? .done : .open))
            await onSaved(updated)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        busy = true; defer { busy = false }
        var patch = TaskPatch()
        if text != task.task { patch.task = text.trimmingCharacters(in: .whitespaces) }
        if assignee?.id != task.assigneePersonId || assigneeName != task.assigneeName {
            patch.assigneePersonId = .some(assignee?.id)
            patch.assigneeName = .some(assignee?.name ?? assigneeName)
        }
        let newDate: String? = hasDeadline ? DateOnly.string(deadline) : nil
        if newDate != task.deadlineDate { patch.deadlineDate = .some(newDate) }
        do {
            let updated = try await APIClient.shared.updateTask(task.id, patch)
            await onSaved(updated)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

/// Быстрое добавление задачи к встрече
@MainActor
struct NewTaskView: View {
    let meetingId: String
    let onCreated: (TaskItem) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var assignee: Person?
    @State private var hasDeadline = false
    @State private var deadline = Calendar.current.date(byAdding: .day, value: 7, to: Date())!
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Задача") { TextField("Что нужно сделать", text: $text, axis: .vertical).lineLimit(2...6) }
                Section("Ответственный") {
                    NavigationLink {
                        PeoplePickerView(selected: assignee) { assignee = $0 }
                    } label: { Label(assignee?.name ?? "Не назначен", systemImage: "person") }
                }
                Section {
                    Toggle("Срок", isOn: $hasDeadline)
                    if hasDeadline { DatePicker("Дата", selection: $deadline, displayedComponents: .date).environment(\.locale, Locale(identifier: "ru_RU")) }
                }
                if let error { Section { ErrorBanner(message: error) } }
            }
            .navigationTitle("Новая задача")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Добавить") { Task { await create() } }.disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        busy = true; defer { busy = false }
        do {
            let t = try await APIClient.shared.createTask(meetingId: meetingId, TaskCreate(task: text.trimmingCharacters(in: .whitespaces), assigneePersonId: assignee?.id, assigneeName: nil, deadlineDate: hasDeadline ? DateOnly.string(deadline) : nil))
            await onCreated(t)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
