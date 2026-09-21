import ReplayKit
import SwiftUI

/// Запись онлайн-встречи (Google Meet, Zoom, Teams): через системную трансляцию экрана iOS отдаёт нашему расширению
/// звук приложения (участники) и микрофон (ваш голос, наушники AirPods). Экран объясняет шаги, запускает трансляцию,
/// показывает её состояние и отправляет запись на обработку после остановки.
@MainActor
struct OnlineMeetingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var active: BroadcastManifest?
    @State private var stopping = false
    @State private var showManualHint = false
    @State private var picker = BroadcastPickerBox()
    private let importer = BroadcastImporter.shared

    var body: some View {
        NavigationStack {
            List {
                if let a = active {
                    Section {
                        HStack(spacing: 12) {
                            Image(systemName: "record.circle").foregroundStyle(.red).font(.title2).symbolEffect(.pulse, options: .repeating)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Идёт запись онлайн-встречи · \(Fmt.clock(a.durationSec))").font(.headline).monospacedDigit()
                                HStack(spacing: 10) {
                                    Label("звук приложения", systemImage: a.hasAppAudio ? "checkmark.circle.fill" : "circle").foregroundStyle(a.hasAppAudio ? .green : .secondary)
                                    Label("микрофон", systemImage: a.hasMicAudio ? "checkmark.circle.fill" : "circle").foregroundStyle(a.hasMicAudio ? .green : .secondary)
                                }
                                .font(.caption)
                            }
                        }
                        Button(role: .destructive) { stopping = true; BroadcastStore.stopRequested = true } label: {
                            Label(stopping ? "Останавливаем…" : "Остановить и отправить на обработку", systemImage: "stop.circle.fill")
                        }
                        .disabled(stopping)
                    } footer: {
                        if !a.hasMicAudio && a.durationSec > 5 {
                            Text("Микрофон не пишется: остановите трансляцию, запустите снова и включите микрофон в диалоге (значок 🎙).")
                        } else {
                            Text("Можно свернуть приложение и вернуться во встречу: запись продолжается. Остановить можно и по красному индикатору вверху экрана.")
                        }
                    }
                } else if let id = importer.importing {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Сводим запись и отправляем на обработку…").font(.subheadline)
                        }
                        .id(id)
                    }
                } else {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            step(1, "Нажмите кнопку ниже и выберите «Запись встречи»")
                            step(2, "Включите микрофон в диалоге (значок 🎙), нажмите «Начать трансляцию»")
                            step(3, "Откройте Google Meet, Zoom или Teams и ведите встречу как обычно — в наушниках или без")
                            step(4, "После встречи вернитесь сюда и нажмите «Остановить» (или остановите трансляцию по красному индикатору)")
                        }
                        .padding(.vertical, 4)
                        // Системный picker нельзя стилизовать: рисуем свою кнопку, а по нажатию программно «нажимаем» кнопку
                        // внутри RPSystemBroadcastPickerView (он лежит рядом размером 1×1 — должен быть в иерархии окна)
                        Button {
                            if !picker.trigger() { showManualHint = true }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "record.circle.fill").font(.system(size: 34)).foregroundStyle(.white)
                                Text("Начать запись онлайн-встречи").font(.headline).foregroundStyle(.white)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(Color.red, in: RoundedRectangle(cornerRadius: 14))
                            .contentShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .background(alignment: .bottomLeading) { BroadcastPickerAnchor(box: picker).frame(width: 1, height: 1).opacity(0.02) }
                        .padding(.vertical, 6)
                        Button { showManualHint = true } label: {
                            Label("Не открылся диалог? Запуск из Пункта управления", systemImage: "questionmark.circle").font(.footnote)
                        }
                    } header: {
                        Text("Как это работает")
                    } footer: {
                        Text("Звук участников берётся из приложения встречи, ваш голос — с микрофона телефона или AirPods. Экран при этом не сохраняется — только звук. Обычные звонки и FaceTime записать нельзя: iOS не отдаёт их звук приложениям.")
                    }
                    if let e = importer.lastError { Section { ErrorBanner(message: e) } }
                }
            }
            .navigationTitle("Онлайн-встреча")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } } }
            .alert("Запуск из Пункта управления", isPresented: $showManualHint) {
                Button("Понятно", role: .cancel) {}
            } message: {
                Text("Откройте Пункт управления, удерживайте кнопку «Запись экрана», выберите «Запись встречи», включите микрофон и нажмите «Начать трансляцию». Потом вернитесь сюда — запись будет видна на этом экране.")
            }
            .task {
                // Следим за манифестом расширения: раз в секунду, пока экран открыт
                while !Task.isCancelled {
                    refresh()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            .onChange(of: scenePhase) { _, p in if p == .active { refresh() } }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.caption.bold()).frame(width: 22, height: 22).background(Color.accentColor.opacity(0.15), in: Circle())
            Text(text).font(.subheadline)
        }
    }

    private func refresh() {
        let now = BroadcastStore.active()
        if now == nil, active != nil { stopping = false }
        active = now
        if now == nil, importer.importing == nil {
            Task {
                await importer.importFinished()
                if RecordingCoordinator.shared.isActive { dismiss() } // импорт начался — открылся экран загрузки
            }
        }
    }
}

/// Ссылка на системный picker трансляции: кнопку внутри него нажимаем программно из своей кнопки SwiftUI
@MainActor
final class BroadcastPickerBox {
    weak var picker: RPSystemBroadcastPickerView?

    /// false — кнопка внутри picker'а не найдена (внутренности iOS изменились): показать инструкцию для Пункта управления
    func trigger() -> Bool {
        guard let picker, let button = picker.firstButton() else { return false }
        button.sendActions(for: .touchUpInside)
        return true
    }
}

private extension UIView {
    func firstButton() -> UIButton? {
        for v in subviews {
            if let b = v as? UIButton { return b }
            if let b = v.firstButton() { return b }
        }
        return nil
    }
}

/// Системный picker с предвыбранным нашим расширением; размещается в иерархии размером 1×1
struct BroadcastPickerAnchor: UIViewRepresentable {
    let box: BroadcastPickerBox
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let v = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        v.preferredExtension = BroadcastStore.extensionBundleId
        v.showsMicrophoneButton = true
        box.picker = v
        return v
    }
    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) { box.picker = uiView }
}
