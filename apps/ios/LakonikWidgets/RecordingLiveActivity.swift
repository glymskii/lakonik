import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Live Activity записи: экран блокировки + Dynamic Island. Кнопки — App Intents, выполняются в приложении.
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.75))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Text(context.attributes.templateEmoji)
                        Image(systemName: context.state.isPaused ? "pause.circle.fill" : "record.circle.fill").foregroundStyle(context.state.isPaused ? .orange : .red)
                    }
                    .font(.title3)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TimerText(state: context.state)
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .lineLimit(1).minimumScaleFactor(0.6)
                        .frame(minWidth: 72, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title).font(.caption).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Controls(state: context.state)
                }
            } compactLeading: {
                Image(systemName: context.state.isPaused ? "pause.fill" : "record.circle.fill").foregroundStyle(context.state.isPaused ? .orange : .red)
            } compactTrailing: {
                TimerText(state: context.state).font(.caption.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: 64)
            } minimal: {
                Image(systemName: "record.circle.fill").foregroundStyle(context.state.isPaused ? .orange : .red)
            }
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<RecordingActivityAttributes>
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(context.attributes.templateEmoji).font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.isPaused ? "Запись на паузе" : "Идёт запись встречи").font(.caption).foregroundStyle(.secondary)
                    Text(context.attributes.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                Spacer()
                TimerText(state: context.state).font(.title2.monospacedDigit().weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
            }
            HStack {
                Controls(state: context.state)
                Spacer()
                if context.state.totalSegments > 0 {
                    Label("\(context.state.uploadedSegments)/\(context.state.totalSegments)", systemImage: "icloud.and.arrow.up").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
    }
}

private struct TimerText: View {
    let state: RecordingActivityAttributes.ContentState
    var body: some View {
        if state.isPaused {
            Text(clock(state.pausedElapsed))
        } else {
            Text(timerInterval: state.timerStart...state.timerStart.addingTimeInterval(12 * 3600), countsDown: false)
                .multilineTextAlignment(.trailing)
        }
    }
    private func clock(_ t: TimeInterval) -> String {
        let s = Int(t); let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%02d:%02d", m, r)
    }
}

private struct Controls: View {
    let state: RecordingActivityAttributes.ContentState
    var body: some View {
        HStack(spacing: 10) {
            if state.isPaused {
                Button(intent: ResumeRecordingIntent()) { Label("Продолжить", systemImage: "play.fill") }.tint(.green)
            } else {
                Button(intent: PauseRecordingIntent()) { Label("Пауза", systemImage: "pause.fill") }.tint(.orange)
            }
            Button(intent: StopRecordingIntent()) { Label("Стоп", systemImage: "stop.fill") }.tint(.red)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .font(.caption.weight(.semibold))
    }
}
