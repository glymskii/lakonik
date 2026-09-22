import SwiftUI

/// Вкладка «Задачи»: все action items по всем встречам, сгруппированные по срокам.
@MainActor
struct TasksView: View {
    enum Filter: String, CaseIterable { case open = "Открытые", all = "Все", done = "Выполненные" }

    @State private var items: [TaskItem] = []
    @State private var openCount = 0
    @State private var overdueCount = 0
    @State private var filter: Filter = .open
    @State private var assignee: Person?
    @State private var people: [Person] = []
    @State private var query = ""
    @State private var editing: TaskItem?
    @State private var loading = false
    @State private var error: String?
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    Picker("", selection: $filter) {
                        ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    if assignee != nil || (overdueCount > 0 && filter != .done) {
                        HStack(spacing: 8) {
                            if let a = assignee {
                                Button { assignee = nil; Task { await load() } } label: {
                                    Label(a.name, systemImage: "xmark.circle.fill").font(.caption).padding(.horizontal, 10).padding(.vertical, 5).background(Color.accentColor.opacity(0.15), in: Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                            if overdueCount > 0 && filter != .done {
                                Label("Просрочено: \(overdueCount)", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red)
                            }
                            Spacer()
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                    }
                }
                if let error { ErrorBanner(message: error).listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                if items.isEmpty && !loading {
                    ContentUnavailableView(
                        filter == .done ? "Выполненных задач нет" : "Задач нет",
                        systemImage: "checklist",
                        description: Text(filter == .open ? "Задачи появляются автоматически из отчётов по встречам. Их можно добавлять и вручную на экране встречи." : "")
                    )
                    .listRowSeparator(.hidden)
                } else {
                    ForEach(groups, id: \.title) { g in
                        Section {
                            ForEach(g.items) { t in
                                TaskRow(task: t) { Task { await toggle(t) } }
                                    .onTapGesture { editing = t }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                        if t.isOwner {
                                            Button(role: .destructive) { Task { await remove(t) } } label: { Label("Удалить", systemImage: "trash") }
                                            Button { editing = t } label: { Label("Изменить", systemImage: "pencil") }.tint(.orange)
                                        }
                                    }
                                    .swipeActions(edge: .leading) {
                                        Button { Task { await toggle(t) } } label: { Label(t.isDone ? "Открыть" : "Готово", systemImage: t.isDone ? "arrow.uturn.backward" : "checkmark") }.tint(.green)
                                    }
                            }
                        } header: {
                            HStack {
                                Text(g.title).foregroundStyle(g.color)
                                Spacer()
                                Text("\(g.items.count)")
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { id in MeetingDetailView(meetingId: id) }
            .searchable(text: $query, prompt: "Поиск по задачам")
            .onChange(of: query) { _, _ in Task { await load() } }
            .refreshable { await load() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section("Ответственный") {
                            Button("Все") { assignee = nil; Task { await load() } }
                            ForEach(people) { p in
                                Button { assignee = p; Task { await load() } } label: {
                                    if let n = p.openTasks, n > 0 { Text("\(p.name) (\(n))") } else { Text(p.name) }
                                }
                            }
                        }
                        NavigationLink { PeopleManagerView() } label: { Label("Справочник ответственных", systemImage: "person.2") }
                    } label: { Label("Фильтр", systemImage: assignee == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }
                }
            }
            .onChange(of: filter) { _, _ in Task { await load() } }
            .task { await load(); people = (try? await APIClient.shared.people()) ?? [] }
            .onReceive(NotificationCenter.default.publisher(for: .workspaceChanged)) { _ in Task { await load(); people = (try? await APIClient.shared.people()) ?? [] } }
            .sheet(item: $editing) { t in
                TaskEditorView(task: t) { _ in await load() } onOpenMeeting: { id in editing = nil; path.append(id) }
            }
        }
    }

    private var navTitle: String { openCount > 0 && filter == .open ? "Задачи · \(openCount)" : "Задачи" }

    private struct Group { let title: String; let color: Color; let items: [TaskItem] }

    private var groups: [Group] {
        let cal = Calendar.current
        let today = DateOnly.startOfToday
        let weekEnd = cal.date(byAdding: .day, value: 7, to: today)!
        var overdue: [TaskItem] = [], todayItems: [TaskItem] = [], week: [TaskItem] = [], later: [TaskItem] = [], noDate: [TaskItem] = [], done: [TaskItem] = []
        for t in items {
            if t.isDone { done.append(t); continue }
            guard let d = t.deadline else { noDate.append(t); continue }
            if d < today { overdue.append(t) } else if cal.isDate(d, inSameDayAs: today) { todayItems.append(t) } else if d < weekEnd { week.append(t) } else { later.append(t) }
        }
        var out: [Group] = []
        if !overdue.isEmpty { out.append(Group(title: "Просрочено", color: .red, items: overdue)) }
        if !todayItems.isEmpty { out.append(Group(title: "Сегодня", color: .orange, items: todayItems)) }
        if !week.isEmpty { out.append(Group(title: "На этой неделе", color: .primary, items: week)) }
        if !later.isEmpty { out.append(Group(title: "Позже", color: .secondary, items: later)) }
        if !noDate.isEmpty { out.append(Group(title: "Без срока", color: .secondary, items: noDate)) }
        if !done.isEmpty { out.append(Group(title: "Выполнено", color: .green, items: done.sorted { ($0.doneAt ?? .distantPast) > ($1.doneAt ?? .distantPast) })) }
        return out
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let page = try await APIClient.shared.tasks(status: filter == .open ? "open" : filter == .done ? "done" : "all", assignee: assignee?.id, query: query)
            items = page.items
            openCount = page.openCount
            overdueCount = page.overdueCount
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func toggle(_ t: TaskItem) async {
        do {
            let updated = try await APIClient.shared.updateTask(t.id, TaskPatch(status: t.isDone ? .open : .done))
            if let i = items.firstIndex(where: { $0.id == t.id }) { items[i] = updated }
            if filter != .all { await load() }
        } catch { self.error = error.localizedDescription }
    }

    private func remove(_ t: TaskItem) async {
        do { try await APIClient.shared.deleteTask(t.id); items.removeAll { $0.id == t.id } } catch { self.error = error.localizedDescription }
    }
}
