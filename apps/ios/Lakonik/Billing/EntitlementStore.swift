import Foundation
import Observation
import StoreKit
import os

/// Тариф пользователя и покупки через StoreKit 2. Источник истины о лимитах — сервер (GET /api/billing/entitlement);
/// после покупки/восстановления транзакция (JWS) отправляется серверу, который сверяет подпись и включает план.
@Observable
@MainActor
final class EntitlementStore {
    static let shared = EntitlementStore()
    private let log = Logger(subsystem: "kz.adv.meetings", category: "billing")

    static let productIds = ["lakonik.starter.monthly", "lakonik.starter.yearly", "lakonik.pro.monthly", "lakonik.pro.yearly", "lakonik.unlimited.monthly", "lakonik.unlimited.yearly"]

    private(set) var entitlement: Entitlement?
    private(set) var products: [Product] = []
    private(set) var purchasing = false
    var lastError: String?
    private var updatesTask: Task<Void, Never>?

    /// Лимит длительности одной записи (секунды); nil — тариф ещё не загружен (не ограничиваем)
    var maxRecordingSec: Int? { entitlement?.limits.maxRecordingSec }
    var onlineMeetingsAllowed: Bool { entitlement?.limits.onlineMeetings ?? true }

    private init() {}

    /// Слушатель транзакций — с первого запуска: продления, покупки на другом устройстве, отзывы
    func start() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) { [weak self] in
            for await result in Transaction.updates {
                guard case .verified(let tx) = result else { continue }
                await self?.report(result.jwsRepresentation)
                await tx.finish()
            }
        }
    }

    func refresh() async {
        do { entitlement = try await APIClient.shared.entitlement() } catch {
            // Старый сервер без биллинга — работаем без лимитов
            if case APIError.server(let status, _) = error, status == 404 { entitlement = nil } else { log.warning("entitlement: \(error.localizedDescription)") }
        }
    }

    func loadProducts() async {
        guard products.isEmpty else { return }
        do {
            products = try await Product.products(for: Self.productIds).sorted { $0.price < $1.price }
        } catch { lastError = "Не удалось загрузить тарифы: \(error.localizedDescription)" }
    }

    func purchase(_ product: Product) async {
        purchasing = true; lastError = nil
        defer { purchasing = false }
        var options: Set<Product.PurchaseOption> = []
        if let t = entitlement?.appAccountToken, let uuid = UUID(uuidString: t) { options.insert(.appAccountToken(uuid)) }
        do {
            switch try await product.purchase(options: options) {
            case .success(let result):
                guard case .verified(let tx) = result else { lastError = "Apple не подтвердил покупку"; return }
                await report(result.jwsRepresentation)
                await tx.finish()
            case .userCancelled: break
            case .pending: lastError = "Покупка ожидает подтверждения (например, родительского контроля)"
            @unknown default: break
            }
        } catch { lastError = error.localizedDescription }
    }

    /// «Восстановить покупки»: синхронизация с App Store и отправка текущих транзакций серверу
    func restore() async {
        purchasing = true; lastError = nil
        defer { purchasing = false }
        do { try await AppStore.sync() } catch { lastError = error.localizedDescription; return }
        var sent = 0
        for await result in Transaction.currentEntitlements {
            guard case .verified = result else { continue }
            await report(result.jwsRepresentation)
            sent += 1
        }
        if sent == 0 { await refresh() }
    }

    private func report(_ jws: String) async {
        do { entitlement = try await APIClient.shared.submitTransaction(jws: jws) } catch { log.error("submit transaction: \(error.localizedDescription)"); lastError = error.localizedDescription }
    }

    func product(_ id: String) -> Product? { products.first { $0.id == id } }
}
