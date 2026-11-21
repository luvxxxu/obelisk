import SwiftUI

/// "이 작업이 늦어지면?" (web DelaySimulator): how much slack the task has before the tasks waiting on it
/// move, and the full impact of +1일 / +3일 / +1주 / a picked date, with "이 작업만 미루기" and "연쇄 적용".
struct TaskDetailDelaySimulator: View {
    var task: TaskItem

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var days: Int?
    @State private var picking = false

    var body: some View {
        let anchor = task.dueDate ?? task.startDate ?? store.today
        let custom = days.map { ![1, 3, 7].contains($0) } ?? false
        let preview = days.map { store.previewFor(task.id, AppStore.shiftSpan(task, $0)) }

        VStack(alignment: .leading, spacing: ObSpace.md) {
            HStack(alignment: .top, spacing: ObSpace.md) {
                Image(systemName: "water.waves")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 20, height: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("이 작업이 늦어지면?")
                        .font(ObFont.bodyStrong)
                        .foregroundStyle(Ob.text)
                        .accessibilityAddTraits(.isHeader)
                    Text(summary(anchor))
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            FlowRow(spacing: 6, lineSpacing: 6) {
                ForEach([1, 3, 7], id: \.self) { n in
                    simButton("+\(daysLabel(n))", pressed: days == n) {
                        withAnimation(ObMotion.standard) { days = days == n ? nil : n }
                    }
                }
                simButton(custom ? "+\(daysLabel(days ?? 0))" : "날짜…", symbol: "calendar", pressed: custom) {
                    picking = true
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("얼마나 늦어질지 골라 보세요")

            if let days, let preview {
                VStack(alignment: .leading, spacing: ObSpace.lg) {
                    Hairline()
                    ImpactView(report: preview.report)
                    actions(preview, days: days)
                }
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .obCard()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("지연 영향 미리보기")
        .sheet(isPresented: $picking) {
            DateTimePickerSheet(
                title: "날짜 선택", date: addDays(anchor, 1), time: nil, today: store.today,
                allowsTime: false, clearable: false, minDate: addDays(anchor, 1)
            ) { d, _ in
                if let d { withAnimation(ObMotion.standard) { days = diffDays(d, anchor) } }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(ObRadius.xl + 8)
        }
    }

    private func summary(_ anchor: ISODate) -> String {
        let waiting = store.dependents(of: task.id).filter(\.isActive)
        if waiting.isEmpty { return "뒤에 이어지는 작업이 없어서 미뤄도 다른 일정에는 영향이 없어요." }
        var slack: Int?
        for t in waiting {
            guard let st = t.startDate ?? t.dueDate else { continue }
            let v = max(0, diffDays(st, anchor))
            slack = slack.map { min($0, v) } ?? v
        }
        guard let slack else { return "후속 작업 \(waiting.count)개가 기다리고 있어요." }
        if slack == 0 {
            let s = store.previewFor(task.id, AppStore.shiftSpan(task, 1)).report.summary
            let conflicts = s.conflictCount > 0 ? " (고정 일정 충돌 \(s.conflictCount))" : ""
            return "여유 없음 · 하루만 늦어도 \(s.delayedCount)개 작업이 밀려요\(conflicts)."
        }
        return "여유 \(slack)일 · \(formatRelativeKo(addDays(anchor, slack), store.today))까지는 미뤄도 다른 일정이 그대로예요."
    }

    private func simButton(_ text: String, symbol: String? = nil, pressed: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 12)) }
                Text(text)
            }
            .font(ObFont.sub.weight(.medium).monospacedDigit())
            .foregroundStyle(pressed ? Ob.onPrimary : Ob.text2)
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .background(pressed ? Ob.primary : Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.sm))
            .overlay(RoundedRectangle(cornerRadius: ObRadius.sm).strokeBorder(pressed ? Ob.primary : Ob.border, lineWidth: 1))
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(TaskDetailPressStyle())
        .accessibilityAddTraits(pressed ? .isSelected : [])
        .animation(ObMotion.fast, value: pressed)
    }

    private func actions(_ preview: DateChangePreview, days: Int) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ObSpace.sm) {
                Spacer(minLength: 0)
                actionButtons(preview, size: .small, fullWidth: false)
            }
            VStack(spacing: ObSpace.sm) {
                actionButtons(preview, size: .regular, fullWidth: true)
            }
        }
    }

    /// 닫기 · 이 작업만 미루기 · 연쇄 적용 · N개 (stacked: the main choice first).
    @ViewBuilder
    private func actionButtons(_ preview: DateChangePreview, size: ControlSize, fullWidth: Bool) -> some View {
        let cascade = preview.cascade.count
        let close = Button("닫기") { withAnimation(ObMotion.standard) { self.days = nil } }
            .buttonStyle(.ob(.ghost, size: size, fullWidth: fullWidth))
        let only = Button("이 작업만 미루기") { Task { await apply(preview.only, cascade: false) } }
            .buttonStyle(.ob(cascade > 1 ? .outline : .primary, size: size, fullWidth: fullWidth))
        let all = Button("연쇄 적용 · \(cascade)개") { Task { await apply(preview.cascade, cascade: true) } }
            .buttonStyle(.ob(.primary, size: size, fullWidth: fullWidth))
        if fullWidth {
            if cascade > 1 { all }
            only
            close
        } else {
            close
            only
            if cascade > 1 { all }
        }
    }

    /// The user already chose cascade or this-task-only after seeing the impact (web: reschedule directly).
    private func apply(_ changes: [DateChange], cascade: Bool) async {
        guard await store.reschedule(changes, rootId: task.id) else { return }
        if cascade { store.history.notify("\(changes.count)개 작업 일정을 함께 옮겼어요", store.history.latest) }
        withAnimation(ObMotion.standard) { days = nil }
    }
}
