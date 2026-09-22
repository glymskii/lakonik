import SwiftUI

/// Настройки сроков (общие для организации): срок по умолчанию, напоминания, SLA отчётов.
@MainActor
struct DeadlineSettingsView: View {
    @State private var s = DeadlineSettings(defaultTaskDeadlineDays: 7, workingDaysOnly: true, remindDaysBefore: 1, remindHourLocal: 9, reportSlaInternalHours: 24, reportSlaExternalHours: 48)
    @State private var loaded = false
    @State private var saving = false
    @State private var error: String?
    @State private var savedAt: Date?

    var body: some View {
        Form {
            Section {
                Stepper(value: $s.defaultTaskDeadlineDays, in: 0...90) {
                    LabeledContent("Срок по умолчанию", value: s.defaultTaskDeadlineDays == 0 ? "не назначать" : "\(s.defaultTaskDeadlineDays) дн.")
                }
                Toggle("Только рабочие дни", isOn: $s.workingDaysOnly)
            } header: {
                Text("Задачи без срока")
            } footer: {
                Text("Если на встрече срок не прозвучал, задача получает дедлайн через указанное число дней после встречи и помечается «по умолчанию».")
            }
            Section {
                Stepper(value: $s.remindDaysBefore, in: 0...30) {
                    LabeledContent("Напоминать за", value: s.remindDaysBefore == 0 ? "в день дедлайна" : "\(s.remindDaysBefore) дн.")
                }
                Stepper(value: $s.remindHourLocal, in: 0...23) {
                    LabeledContent("Время напоминания", value: String(format: "%02d:00", s.remindHourLocal))
                }
            } header: {
                Text("Напоминания")
            } footer: {
                Text("Push владельцу встречи по открытым задачам с приближающимся сроком (время по Алматы).")
            }
            Section {
                Stepper(value: $s.reportSlaInternalHours, in: 1...168, step: 1) {
                    LabeledContent("Внутренние встречи", value: "\(s.reportSlaInternalHours) ч")
                }
                Stepper(value: $s.reportSlaExternalHours, in: 1...168, step: 1) {
                    LabeledContent("Клиенты и вендоры", value: "\(s.reportSlaExternalHours) ч")
                }
            } header: {
                Text("Срок отправки отчёта после встречи")
            } footer: {
                Text("Рекомендуемые сроки: команде — в течение 24 часов, клиенту — 48 часов. Показываются на экране встречи.")
            }
            if let error { Section { ErrorBanner(message: error) } }
        }
        .navigationTitle("Сроки")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Сохраняю…" : "Сохранить") { Task { await save() } }.disabled(saving || !loaded)
            }
        }
        .task { await load() }
        .overlay(alignment: .bottom) {
            if let savedAt { Text("Сохранено \(savedAt.formatted(date: .omitted, time: .shortened))").font(.caption).padding(8).background(.thinMaterial, in: Capsule()).padding(.bottom, 12) }
        }
    }

    private func load() async {
        do { s = try await APIClient.shared.deadlineSettings(); loaded = true } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        saving = true; defer { saving = false }
        do { s = try await APIClient.shared.saveDeadlineSettings(s); savedAt = Date(); error = nil } catch { self.error = error.localizedDescription }
    }
}
