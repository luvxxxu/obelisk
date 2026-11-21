import SwiftUI

// Shared pieces of time planning: the estimate menu, a minutes editor sheet (기록 추가 / 실제 시간 고치기),
// and the floating running-timer pill.

/// "1시간 30분" for an estimate, "없음" without one.
func estimateLabel(_ minutes: Int?) -> String {
    minutes.map(formatDurationKo) ?? "없음"
}

/// Menu items for picking an estimate: the presets, 직접 입력, and 지우기.
struct EstimateMenuItems: View {
    var current: Int?
    var onPick: (Int?) -> Void
    var onCustom: () -> Void

    var body: some View {
        Section("예상 시간") {
            ForEach(ESTIMATE_PRESETS, id: \.self) { m in
                Button {
                    onPick(m)
                } label: {
                    if current == m {
                        Label(formatDurationKo(m), systemImage: "checkmark")
                    } else {
                        Text(formatDurationKo(m))
                    }
                }
            }
        }
        Button {
            onCustom()
        } label: {
            Label("직접 입력…", systemImage: "keyboard")
        }
        if current != nil {
            Button(role: .destructive) {
                onPick(nil)
            } label: {
                Label("예상 시간 지우기", systemImage: "xmark")
            }
        }
    }
}

/// Hours + minutes wheels (5-minute steps), for an estimate, logged time or a corrected total.
struct MinutesEditorSheet: View {
    var title: String
    var message: String?
    var initial: Int
    /// The smallest value that can be saved (0 for "실제 시간 고치기", 1 otherwise).
    var minimum: Int = 1
    var actionLabel = "저장"
    var onSave: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var hours = 0
    @State private var minutes = 0
    @State private var text = ""
    @FocusState private var typing: Bool

    private var total: Int { hours * 60 + minutes }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                if let message {
                    Text(message)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 0) {
                    Picker("시간", selection: $hours) {
                        ForEach(0 ..< 24, id: \.self) { Text("\($0)시간").tag($0) }
                    }
                    .pickerStyle(.wheel)
                    Picker("분", selection: $minutes) {
                        ForEach(Array(stride(from: 0, to: 60, by: 5)), id: \.self) { Text("\($0)분").tag($0) }
                    }
                    .pickerStyle(.wheel)
                }
                .frame(height: 160)
                TextField("또는 직접: 1시간 30분, 90m", text: $text)
                    .textFieldStyle(.ob(focused: typing))
                    .focused($typing)
                    .submitLabel(.done)
                    .onSubmit(apply)
                    .onChange(of: text) { _, v in
                        if let m = parseDuration(v) ?? Int(v.trimmingCharacters(in: .whitespaces)).flatMap({ $0 > 0 && $0 <= 1440 ? $0 : nil }) {
                            hours = min(23, m / 60)
                            minutes = (m % 60) / 5 * 5
                        }
                    }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .obPage()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionLabel) { apply() }
                        .fontWeight(.semibold)
                        .disabled(total < minimum)
                }
            }
        }
        .onAppear {
            hours = min(23, initial / 60)
            minutes = (initial % 60) / 5 * 5
        }
    }

    private func apply() {
        guard total >= minimum else { return }
        onSave(total)
        dismiss()
    }
}

/// Floating glass capsule above the composer while a clock runs: "#12 제목 · 32:10", stop.
/// Tapping it opens the task.
struct RunningTimerPill: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        if let r = store.running {
            HStack(spacing: ObSpace.sm) {
                Button {
                    open(r)
                } label: {
                    HStack(spacing: ObSpace.sm) {
                        Circle()
                            .fill(Ob.danger)
                            .frame(width: 7, height: 7)
                            .accessibilityHidden(true)
                        Text("#\(r.task.number)")
                            .font(ObFont.footnote.monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        Text(r.task.title)
                            .font(ObFont.sub.weight(.medium))
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        Spacer(minLength: ObSpace.xs)
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(formatClock(r.elapsed(now: ctx.date)))
                                .font(ObFont.sub.monospacedDigit())
                                .foregroundStyle(Ob.text2)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("#\(r.task.number) \(r.task.title) 시간 기록 중")
                .accessibilityHint("작업 열기")

                Button {
                    Task { await store.timer(r.task.id, start: false) }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Ob.onPrimary)
                        .frame(width: 30, height: 30)
                        .background(Ob.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("타이머 멈추기")
            }
            .padding(.leading, ObSpace.lg)
            .padding(.trailing, 7)
            .frame(height: 44)
            .obGlass(in: Capsule(), interactive: true)
            .padding(.horizontal, ObSpace.md)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func open(_ r: RunningTimer) {
        if r.task.workspaceId != store.workspace?.id {
            Task {
                await store.switchWorkspace(r.task.workspaceId)
                router.openTask(r.task.id)
            }
        } else {
            router.openTask(r.task.id)
        }
    }
}

extension Router {
    /// "실제 시간 고치기" for a task (from the completion toast or the task screen).
    func presentActualEditor(_ store: AppStore, taskId: String) {
        let current = store.task(taskId)?.actual ?? 0
        present(.init(id: "actual-\(taskId)", detents: [.medium]) {
            MinutesEditorSheet(
                title: "실제 시간 고치기",
                message: "이 작업에 내가 쓴 시간을 이 값으로 바꿔요. 다른 사람의 기록은 그대로예요.",
                initial: current,
                minimum: 0
            ) { m in
                Task { await store.setActual(taskId, minutes: m) }
            }
        })
    }
}
