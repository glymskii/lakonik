import QuartzCore
import SwiftUI

/// «Лента» из линий, дышащая под голос: амплитуда — от уровня микрофона (с атакой и плавным спадом),
/// фаза — от времени. На паузе лента сужается и замедляется, при стопе замирает.
struct FlowWaveView: View {
    let levels: LevelHistory
    /// Идёт запись — лента реагирует на голос
    let isActive: Bool
    /// Анимировать вообще (запись, пауза, прерывание); после стопа кадр замирает
    let isAnimating: Bool
    @State private var smoother = Smoother()

    private static let lines = 18
    private static let stepX: CGFloat = 3
    private static let gradient = Gradient(colors: [.red, .pink, .purple, .blue])

    var body: some View {
        // Дата из контекста таймлайна должна попасть в замыкание Canvas: иначе SwiftUI считает его неизменившимся и не перерисовывает
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !isAnimating)) { timeline in
            Canvas(rendersAsynchronously: true) { ctx, size in
                let now = timeline.date.timeIntervalSinceReferenceDate
                let target = isActive ? 0.10 + 0.90 * Double(levels.latest) : 0.02
                let amp = smoother.step(target: target, now: now, speed: isActive ? 1 : 0.3)
                draw(ctx, size, amp: amp, t: smoother.phase)
            }
        }
        .allowsHitTesting(false)
    }

    private func draw(_ ctx: GraphicsContext, _ size: CGSize, amp: Double, t: Double) {
        let w = size.width, mid = size.height / 2
        let scale = size.height * 0.42
        let shading = GraphicsContext.Shading.linearGradient(Self.gradient, startPoint: CGPoint(x: 0, y: mid), endPoint: CGPoint(x: w, y: mid))
        let thickness = 0.10 + 0.55 * amp
        for k in 0..<Self.lines {
            let v = Double(k) / Double(Self.lines - 1) * 2 - 1 // положение линии в ленте: −1 … 1
            var path = Path()
            var x: CGFloat = 0
            while x <= w + Self.stepX {
                let u = Double(min(x, w) / w)
                let env = pow(max(0, sin(.pi * u)), 1.15) // концы ленты сходятся в точку
                let base = 0.55 * sin(2 * .pi * 1.25 * u - 2.2 * t) + 0.45 * sin(2 * .pi * 2.05 * u + 1.4 * t + 0.8)
                // ширина ленты меняется по x: в нулях линии пересекаются, получается «скрученная» лента
                let ribbon = thickness * sin(2 * .pi * 0.95 * u + 0.8 * t + 0.5) + 0.06 * sin(2 * .pi * 3.1 * u - 3.0 * t)
                let y = mid + CGFloat(env * (amp * base + v * ribbon)) * scale
                if x == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                x += Self.stepX
            }
            var layer = ctx
            layer.opacity = 0.35 + 0.5 * (1 - abs(v)) // средние линии ярче — лента выглядит объёмной
            layer.stroke(path, with: shading, style: StrokeStyle(lineWidth: 1.1, lineCap: .round, lineJoin: .round))
        }
    }

    /// Сглаживание амплитуды (быстрая атака, медленный спад) и собственное время анимации
    final class Smoother {
        private(set) var value: Double = 0
        private(set) var phase: Double = 0
        private var last: Double?

        func step(target: Double, now: Double, speed: Double) -> Double {
            let dt = min(0.1, max(0, now - (last ?? now)))
            last = now
            phase += dt * speed
            let tau = target > value ? 0.07 : 0.30
            value += (target - value) * (1 - exp(-dt / tau))
            return value
        }
    }
}

/// Осциллограмма записи: столбики уровня уходят влево от курсора, снизу — линейка времени, сверху — отметки.
struct ScrollingWaveformView: View {
    let levels: LevelHistory
    let markers: [Marker]
    /// Часы идут (запись). На паузе и после стопа кадр замирает.
    let isRunning: Bool
    var pxPerSec: CGFloat = 50
    var playheadFraction: CGFloat = 0.55

    private static let rulerHeight: CGFloat = 24
    private static let barWidth: CGFloat = 1.6
    private static let barGradient = Gradient(colors: [.orange, .red, .red, .orange])

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !isRunning)) { timeline in
            Canvas { ctx, size in draw(ctx, size, frame: timeline.date) }
        }
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.1), .init(color: .black, location: 0.92), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
        .allowsHitTesting(false)
    }

    /// `frame` — дата кадра из TimelineView; нужна только чтобы замыкание Canvas менялось от кадра к кадру
    private func draw(_ ctx: GraphicsContext, _ size: CGSize, frame: Date) {
        _ = frame
        let now = levels.now
        let w = size.width
        let barsH = size.height - Self.rulerHeight
        let midY = barsH / 2
        let px = (w * playheadFraction).rounded()
        let leftSec = Double(px / pxPerSec) + 0.2
        let rightSec = Double((w - px) / pxPerSec) + 0.2

        // Линейка: деления каждые 0.25 с, подписи каждую секунду
        var tick = max(0, floor((now - leftSec) * 4) / 4)
        while tick <= now + rightSec {
            let x = px + CGFloat(tick - now) * pxPerSec
            let isMajor = abs(tick - tick.rounded()) < 0.001
            var p = Path()
            p.move(to: CGPoint(x: x, y: barsH + 3))
            p.addLine(to: CGPoint(x: x, y: barsH + 3 + (isMajor ? 7 : 3)))
            ctx.stroke(p, with: .color(.secondary.opacity(isMajor ? 0.8 : 0.45)), lineWidth: 1)
            if isMajor {
                let label = Text(Fmt.clock(tick)).font(.system(size: 10, weight: .medium, design: .rounded).monospacedDigit()).foregroundStyle(.secondary)
                ctx.draw(label, at: CGPoint(x: x, y: barsH + 17), anchor: .center)
            }
            tick += 0.25
        }

        // Осевая линия слева от курсора (тишина рисуется как тонкая линия)
        var axis = Path()
        axis.move(to: CGPoint(x: 0, y: midY))
        axis.addLine(to: CGPoint(x: px, y: midY))
        ctx.stroke(axis, with: .color(.red.opacity(0.35)), lineWidth: 1)

        // Столбики: смесь пика и RMS, симметрично относительно оси
        var bars = Path()
        for s in levels.samples(from: now - leftSec) {
            let x = px - CGFloat(now - s.t) * pxPerSec
            guard x <= px, x >= -Self.barWidth else { continue }
            let level = CGFloat(0.6 * s.peak + 0.4 * s.rms)
            let h = max(2, pow(level, 1.15) * (barsH - 10))
            bars.addRoundedRect(in: CGRect(x: x - Self.barWidth / 2, y: midY - h / 2, width: Self.barWidth, height: h), cornerSize: CGSize(width: 1, height: 1))
        }
        ctx.fill(bars, with: .linearGradient(Self.barGradient, startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: barsH)))

        // Отметки важных моментов
        if !markers.isEmpty {
            var flag = ctx.resolve(Image(systemName: "bookmark.fill"))
            flag.shading = .color(.accentColor)
            for m in markers {
                let x = px - CGFloat(now - m.atSec) * pxPerSec
                guard x > -10, x < w + 10 else { continue }
                var line = Path()
                line.move(to: CGPoint(x: x, y: 0))
                line.addLine(to: CGPoint(x: x, y: barsH))
                ctx.stroke(line, with: .color(.accentColor.opacity(0.8)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                ctx.draw(flag, in: CGRect(x: x - 5, y: 0, width: 10, height: 13))
            }
        }

        // Курсор
        var head = Path()
        head.move(to: CGPoint(x: px, y: 0))
        head.addLine(to: CGPoint(x: px, y: barsH))
        ctx.stroke(head, with: .color(.primary), lineWidth: 2)
        var caps = Path()
        let c: CGFloat = 5
        caps.move(to: CGPoint(x: px - c, y: 0)); caps.addLine(to: CGPoint(x: px + c, y: 0)); caps.addLine(to: CGPoint(x: px, y: c + 1)); caps.closeSubpath()
        caps.move(to: CGPoint(x: px - c, y: barsH)); caps.addLine(to: CGPoint(x: px + c, y: barsH)); caps.addLine(to: CGPoint(x: px, y: barsH - c - 1)); caps.closeSubpath()
        ctx.fill(caps, with: .color(.primary))
    }
}

/// Таймер записи: минуты:секунды крупно и сотые мельче, 30 обновлений в секунду по часам записи
struct RecordingClockLabel: View {
    let levels: LevelHistory
    let isRunning: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isRunning)) { _ in
            let t = levels.now
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(Fmt.clock(t))
                    .font(.system(size: 60, weight: .light, design: .rounded).monospacedDigit())
                Text(String(format: ".%02d", Int((t - floor(t)) * 100)))
                    .font(.system(size: 24, weight: .light, design: .rounded).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
