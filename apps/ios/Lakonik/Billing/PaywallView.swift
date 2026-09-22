import StoreKit
import SwiftUI

/// Экран тарифа: текущий план и использование, карточки подписок, восстановление покупок, Enterprise для организаций
@MainActor
struct PaywallView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var store = EntitlementStore.shared
    @State private var yearly = false
    /// Причина показа (код квоты) — объясняем, что именно закончилось
    var reason: String? = nil

    private let tiers: [(key: String, title: String, features: [String])] = [
        ("starter", "Starter", ["5 часов записей в месяц", "Запись до 60 минут", "Отчёты быстрой моделью"]),
        ("pro", "Pro", ["15 часов в месяц", "Запись до 3 часов", "Отчёты лучшей моделью", "Запись онлайн-встреч", "7 дней бесплатно"]),
        ("unlimited", "Безлимит", ["До 40 часов в месяц", "Запись до 5 часов", "Лучшая модель, приоритет обработки", "Запись онлайн-встреч"]),
    ]

    var body: some View {
        NavigationStack {
            List {
                if let reason { Section { reasonBanner(reason) } }
                currentSection
                Section {
                    Picker("Период", selection: $yearly) { Text("В месяц").tag(false); Text("В год · −20 %").tag(true) }.pickerStyle(.segmented)
                    ForEach(tiers, id: \.key) { t in tierRow(t.key, t.title, t.features) }
                } header: { Text("Тарифы") } footer: {
                    Text("Подписка продлевается автоматически, отменить можно в любой момент в настройках Apple ID. Оплата списывается через App Store.")
                }
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Enterprise для организаций").font(.headline)
                        Text("Общий пул часов на команду, приглашения без ограничений, приватные шаблоны отчётов, оплата по счёту.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Button { openURL(URL(string: "mailto:support@lakonik.app?subject=Enterprise")!) } label: { Label("Написать нам", systemImage: "envelope") }
                }
                Section {
                    Button { Task { await store.restore() } } label: { Label("Восстановить покупки", systemImage: "arrow.clockwise") }.disabled(store.purchasing)
                    Button { openURL(URL(string: "https://apps.apple.com/account/subscriptions")!) } label: { Label("Управление подпиской", systemImage: "creditcard") }
                    HStack {
                        Link("Условия", destination: URL(string: "https://lakonik.app/terms")!)
                        Text("·").foregroundStyle(.secondary)
                        Link("Конфиденциальность", destination: URL(string: "https://lakonik.app/privacy")!)
                    }.font(.footnote)
                }
                if let e = store.lastError { Section { ErrorBanner(message: e) } }
            }
            .navigationTitle("Тариф")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } } }
            .task { await store.loadProducts(); await store.refresh() }
        }
    }

    @ViewBuilder private var currentSection: some View {
        Section("Сейчас") {
            if let e = store.entitlement {
                LabeledContent("План", value: e.tierTitle + (e.source == "enterprise" ? " · организация" : ""))
                if let limit = e.limits.monthlyLimitSec {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text("Часы в этом месяце"); Spacer(); Text("\(Fmt.hours(e.usage.monthlySec)) из \(Fmt.hours(limit))").foregroundStyle(.secondary) }
                        ProgressView(value: min(1, Double(e.usage.monthlySec) / Double(max(1, limit))))
                    }
                }
                if let daily = e.limits.dailyRecordings { LabeledContent("Записей сегодня", value: "\(e.usage.dailyCount) из \(daily)") }
                LabeledContent("Макс. длительность записи", value: Fmt.hours(e.limits.maxRecordingSec))
                if let s = e.subscription, let until = s.expiresAt {
                    LabeledContent(s.autoRenew ? "Продление" : "Действует до", value: until.formatted(.dateTime.day().month(.abbreviated).year().locale(Locale(identifier: "ru_RU"))))
                }
            } else if store.loaded {
                Text("На этом сервере тарифы не включены — ограничений нет.").foregroundStyle(.secondary)
            } else {
                HStack { ProgressView(); Text("Загрузка…").foregroundStyle(.secondary) }
            }
        }
    }

    @ViewBuilder private func reasonBanner(_ code: String) -> some View {
        let text: String = switch code {
        case "quota.daily": "На бесплатном тарифе — до 5 записей в день. Подписка снимает это ограничение."
        case "quota.duration": "Запись остановлена на границе тарифа. С подпиской записи длиннее — до 5 часов."
        case "quota.monthly": "Часы этого месяца закончились. Подписка добавит часов; лимит обновится в начале месяца."
        case "feature.online_meetings": "Запись онлайн-встреч доступна с тарифа Pro."
        default: "Лимит тарифа исчерпан."
        }
        Label(text, systemImage: "exclamationmark.circle").font(.subheadline)
    }

    @ViewBuilder private func tierRow(_ key: String, _ title: String, _ features: [String]) -> some View {
        let product = store.product("lakonik.\(key).\(yearly ? "yearly" : "monthly")")
        let isCurrent = store.entitlement?.tier == key && store.entitlement?.source == "subscription"
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                if let product { Text(product.displayPrice + (yearly ? " / год" : " / мес")).font(.subheadline.weight(.semibold)) }
            }
            ForEach(features, id: \.self) { f in Label(f, systemImage: "checkmark").font(.caption).foregroundStyle(.secondary) }
            if isCurrent {
                Text("Ваш текущий план").font(.caption).foregroundStyle(.green)
            } else if let product {
                Button {
                    Task { await store.purchase(product) }
                } label: {
                    HStack { if store.purchasing { ProgressView().tint(.white) }; Text(key == "pro" && !(store.entitlement?.isPaid ?? false) ? "Попробовать 7 дней бесплатно" : "Выбрать \(title)") }
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).disabled(store.purchasing)
            } else {
                Text("Тарифы загружаются из App Store…").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}

extension Fmt {
    /// 5400 → «1 ч 30 мин», 300 → «5 мин»
    static func hours(_ sec: Int) -> String {
        let h = sec / 3600, m = (sec % 3600) / 60
        if h > 0 && m > 0 { return "\(h) ч \(m) мин" }
        if h > 0 { return "\(h) ч" }
        return "\(m) мин"
    }
}
