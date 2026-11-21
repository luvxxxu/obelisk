import SwiftUI

/// Right under the properties card: how likely the due date is ("제때 끝낼 확률 72%"), the 85% date,
/// and a way to see which dates could be promised instead.
struct TaskOddsLine: View {
    var task: TaskItem
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let o = store.odds?.odds(task.id)
        Group {
            if task.isActive, task.dueDate != nil {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Image(systemName: "chart.bar")
                        .font(.system(size: 13))
                        .foregroundStyle(Ob.text3)
                        .accessibilityHidden(true)
                    if let o, let p = o.onTime {
                        let tone: Tone = p < 0.6 ? .warn : .neutral
                        VStack(alignment: .leading, spacing: 2) {
                            Text("제때 끝낼 확률 \(percentKo(p))")
                                .font(ObFont.sub.weight(.medium))
                                .foregroundStyle(tone == .warn ? Ob.warnText : Ob.text)
                            if let p85 = o.p85 {
                                Text("85% 확률로 \(formatRelativeKo(p85, store.today))까지 끝나요")
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.text3)
                            }
                        }
                    } else {
                        Text(store.odds == nil ? "완료 확률 계산 중" : "완료 확률을 낼 수 없어요")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                    }
                    Spacer(minLength: ObSpace.sm)
                    if store.canEdit(task) {
                        Button("가능한 날짜 보기") {
                            router.present(.init(id: "commit-\(task.id)", detents: [.large]) {
                                CommitSheet(taskId: task.id)
                            })
                        }
                        .buttonStyle(.ob(.outline, size: .small))
                    }
                }
                .padding(.horizontal, ObSpace.xs)
                .task(id: task.dueDate ?? "-") { await store.loadOdds() }
            }
        }
    }
}

/// 시간 (web TaskDetail time section): 예상 시간, 실제 시간 with a start/stop timer, everyone's entries,
/// 기록 추가 and 실제 시간 고치기.
struct TaskTimeSection: View {
    var task: TaskItem
    var readOnly: Bool

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var entries: [TimeEntry]?
    @State private var showEntries = false
    @State private var customEstimate = false

    private var running: RunningTimer? {
        store.running?.task.id == task.id ? store.running : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            TaskDetailSectionHead(icon: "timer", title: "시간")
            VStack(spacing: 0) {
                estimateRow
                Hairline().padding(.leading, 22 + ObSpace.md)
                actualRow
                if !(entries ?? []).isEmpty {
                    Hairline().padding(.leading, 22 + ObSpace.md)
                    entriesRows
                }
            }
            .padding(.horizontal, ObSpace.lg)
            .obCard(padding: 0)
            if !readOnly {
                HStack(spacing: ObSpace.sm) {
                    Button {
                        router.present(.init(id: "log-\(task.id)", detents: [.medium]) {
                            MinutesEditorSheet(title: "기록 추가", message: "오늘 이 작업에 쓴 시간을 더해요.", initial: 30, actionLabel: "추가") { m in
                                Task { await store.logTime(task.id, minutes: m) }
                            }
                        })
                    } label: {
                        ListsButtonLabel(title: "기록 추가", symbol: "plus")
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                    if task.actual > 0 || running != nil {
                        Button {
                            router.presentActualEditor(store, taskId: task.id)
                        } label: {
                            ListsButtonLabel(title: "실제 시간 고치기", symbol: "pencil")
                        }
                        .buttonStyle(.ob(.ghost, size: .small))
                    }
                }
            }
        }
        .task(id: "\(task.id)|\(store.timeRevision)|\(task.actual)|\(running?.entry.id ?? "")") {
            entries = await store.timeEntries(task.id)
        }
        .sheet(isPresented: $customEstimate) {
            MinutesEditorSheet(title: "예상 시간", initial: task.estimateMinutes ?? 60) { m in
                Task { await store.setEstimate(task.id, m) }
            }
            .presentationDetents([.medium])
        }
    }

    private func label(_ icon: String, _ text: String) -> some View {
        HStack(spacing: ObSpace.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
                .frame(width: 22)
            Text(text)
                .font(ObFont.body)
                .foregroundStyle(Ob.text2)
        }
    }

    // MARK: 예상 시간

    @ViewBuilder
    private var estimateRow: some View {
        let row = HStack(spacing: ObSpace.sm) {
            label("hourglass", "예상 시간")
            Spacer(minLength: ObSpace.sm)
            Text(estimateLabel(task.estimateMinutes))
                .font(ObFont.body)
                .foregroundStyle(task.estimateMinutes == nil ? Ob.text3 : Ob.text)
            if !readOnly {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Ob.text3)
            }
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        if readOnly {
            row.accessibilityElement(children: .combine)
        } else {
            Menu {
                EstimateMenuItems(current: task.estimateMinutes) { m in
                    Task { await store.setEstimate(task.id, m) }
                } onCustom: {
                    customEstimate = true
                }
            } label: {
                row
            }
            .tint(Ob.text)
            .accessibilityLabel("예상 시간: \(estimateLabel(task.estimateMinutes))")
        }
    }

    // MARK: 실제 시간 + timer

    private var actualRow: some View {
        HStack(spacing: ObSpace.sm) {
            label("stopwatch", "실제 시간")
            Spacer(minLength: ObSpace.sm)
            VStack(alignment: .trailing, spacing: 3) {
                if let r = running {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        let live = task.actual + r.elapsed(now: ctx.date) / 60
                        HStack(spacing: 6) {
                            Text(formatClock(r.elapsed(now: ctx.date)))
                                .font(ObFont.body.monospacedDigit())
                                .foregroundStyle(Ob.text)
                            Text("· 합계 \(formatDurationKo(max(1, live)))")
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text3)
                        }
                    }
                } else {
                    Text(task.actual > 0 ? formatDurationKo(task.actual) : "기록 없음")
                        .font(ObFont.body)
                        .foregroundStyle(task.actual > 0 ? Ob.text : Ob.text3)
                }
                if let est = task.estimateMinutes, task.actual > 0 {
                    progress(actual: task.actual, estimate: est)
                }
            }
            if !readOnly, task.isActive {
                Button {
                    Task { await store.timer(task.id, start: running == nil) }
                } label: {
                    Image(systemName: running == nil ? "play.fill" : "stop.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(running == nil ? Ob.text : Ob.onPrimary)
                        .frame(width: 32, height: 32)
                        .background(running == nil ? Ob.surface2 : Ob.primary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(running == nil ? "타이머 시작" : "타이머 멈추기")
            }
        }
        .padding(.vertical, ObSpace.sm)
        .frame(minHeight: 52)
    }

    /// A hairline bar: how much of the estimate is used (orange once it runs over).
    private func progress(actual: Int, estimate: Int) -> some View {
        let ratio = Double(actual) / Double(max(1, estimate))
        let over = ratio > 1
        return HStack(spacing: 6) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Ob.surface3)
                    Capsule().fill(over ? Ob.warn : Ob.text2)
                        .frame(width: geo.size.width * min(1, ratio))
                }
            }
            .frame(width: 64, height: 3)
            Text(over ? "\(formatDurationKo(actual - estimate)) 넘음" : "예상의 \(percentKo(ratio))")
                .font(ObFont.caption)
                .foregroundStyle(over ? Ob.warnText : Ob.text3)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: entries

    @ViewBuilder
    private var entriesRows: some View {
        let list = entries ?? []
        Button {
            withAnimation(ObMotion.standard) { showEntries.toggle() }
        } label: {
            HStack(spacing: ObSpace.sm) {
                label("list.bullet", "기록 \(list.count)개")
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .rotationEffect(.degrees(showEntries ? 90 : 0))
                    .foregroundStyle(Ob.text3)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if showEntries {
            ForEach(list) { e in
                entryRow(e)
                    .transition(.opacity)
            }
            .padding(.bottom, ObSpace.xs)
        }
    }

    private func entryRow(_ e: TimeEntry) -> some View {
        let who = e.mine == true ? "나" : (e.userName ?? "예전 멤버")
        let when = relativeTime(e.startedAt)
        return HStack(spacing: ObSpace.sm) {
            Text(who)
                .font(ObFont.sub)
                .foregroundStyle(Ob.text)
                .lineLimit(1)
            Chip(text: e.source.labelKo, filled: true)
            Text(when)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
            Spacer(minLength: ObSpace.sm)
            Text(e.isRunning ? "기록 중" : formatDurationKo(e.minutes ?? 0))
                .font(ObFont.sub.monospacedDigit())
                .foregroundStyle(e.isRunning ? Ob.danger : Ob.text2)
            if e.mine == true, !e.isRunning, !readOnly {
                Menu {
                    Button(role: .destructive) {
                        Task { await store.deleteTimeEntry(e.id) }
                    } label: {
                        Label("기록 지우기", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Ob.text3)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("기록 메뉴")
            }
        }
        .padding(.leading, 22 + ObSpace.md)
        .frame(minHeight: 36)
        .contextMenu {
            if e.mine == true, !e.isRunning, !readOnly {
                Button(role: .destructive) {
                    Task { await store.deleteTimeEntry(e.id) }
                } label: {
                    Label("기록 지우기", systemImage: "trash")
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
