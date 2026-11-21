import SwiftUI

/// 오늘 (web app/(app)/today/page.tsx): greeting, progress, the forecast callout, 기한 지남 / 오늘,
/// and what was finished today. Tasks due at a time move to 기한 지남 the minute it passes.
struct TodayScreen: View {
    @AppStorage("today.mode", store: AppGroup.defaults) private var mode: TodayMode = .list

    var body: some View {
        switch mode {
        case .list: ListsMinuteClock { now in TodayContent(now: now, mode: $mode) }
        case .schedule: TodaySchedule(mode: $mode)
        }
    }
}

private struct TodayContent: View {
    var now: Clock
    @Binding var mode: TodayMode
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let today = store.today
        let tasks = store.taskList
        let tz = store.timezone
        let overdue = selectView(tasks, .overdue, today, now)
        let todays = selectView(tasks, .today, today).filter { !isOverdue($0, today, now) }
        let done = tasks.filter { $0.status == .done && completedOn($0, tz) == today }.listsByCompletion()
        let fc = forecast(store.planItemsNow, store.deps, today)
        let risk = fc.summary.delayedCount + fc.summary.conflictCount
        let planned = done.count + overdue.count + todays.count
        let jevConnected = store.user?.jev.connected ?? false
        let rows = (overdue + todays).map(\.id) + router.selection.shown("오늘 완료", done, collapsedByDefault: done.count > 3)

        SelectableList(rows: rows) {
            ListsHeader(
                "오늘",
                description: "\(longDateKo(today)) · \(greeting), \(store.user?.name ?? "")님",
                actions: {
                    if planned > 0 { TodayProgress(done: done.count, planned: planned) }
                }
            )
            .listsPlainRow()

            TodayModePicker(mode: $mode)
                .padding(.horizontal, ObSpace.page)
                .padding(.bottom, ObSpace.md)
                .listsPlainRow()

            // On a phone the title row has no room for a second control: Jev gets its own line.
            if jevConnected, overdue.count + todays.count > 0 {
                Button {
                    router.presentJev(.postpone(scope: .today))
                } label: {
                    ListsButtonLabel(title: "미룰 작업 고르기", symbol: "scalemass")
                }
                .buttonStyle(.ob(.outline, size: .small))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, ObSpace.page)
                .padding(.bottom, ObSpace.sm)
                .listsPlainRow()
            }

            if risk > 0 {
                TodayRiskCallout(report: fc)
                    .listsPlainRow(horizontal: ObSpace.page)
            }

            TaskSection("기한 지남", tasks: overdue, tone: .danger)
            TaskSection(overdue.isEmpty ? nil : "오늘", tasks: todays)

            if overdue.isEmpty, todays.isEmpty {
                EmptyState(
                    done.isEmpty ? "오늘은 비어 있어요" : "오늘 할 일을 모두 끝냈어요",
                    message: done.isEmpty
                        ? "아래 입력창에 할 일을 적어보세요. “내일”, “금요일”, “#프로젝트” 같은 표현을 알아들어요."
                        : "\(done.count)개 완료. 푹 쉬어도 좋아요."
                ) {
                    if done.isEmpty {
                        ListsNewTaskButton(prefill: NewTask(title: "", dueDate: today))
                    } else {
                        ListsPageButton(title: "다가오는 일정 보기", symbol: "calendar", page: .upcoming)
                    }
                }
                .listsPlainRow()
            }

            TaskSection("오늘 완료", tasks: done, collapsible: true, defaultCollapsed: done.count > 3)
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    private var greeting: String {
        let hour = now.minutes / 60
        return hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "좋은 저녁이에요"
    }
}

/// "3/5 완료": a quiet pill of plain text; a green check once everything is done.
private struct TodayProgress: View {
    var done: Int
    var planned: Int

    var body: some View {
        let all = done == planned
        HStack(spacing: 4) {
            if all {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Ob.ok)
            }
            Text("\(done)/\(planned)")
                .fontWeight(.medium)
                .foregroundStyle(Ob.text)
                .monospacedDigit()
            Text("완료")
        }
        .font(ObFont.footnote)
        .foregroundStyle(Ob.text2)
        .padding(.horizontal, ObSpace.md)
        .frame(height: ObSize.controlSm)
        .background(Ob.surface2, in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("오늘 \(planned)개 중 \(done)개 완료")
    }
}

/// The whole callout opens 파급 예측 (web riskAlert).
private struct TodayRiskCallout: View {
    var report: ImpactReport
    @Environment(Router.self) private var router

    var body: some View {
        let s = report.summary
        let tone: Tone = s.conflictCount > 0 ? .danger : .warn
        Button {
            router.open(.forecast)
        } label: {
            HStack(alignment: .center, spacing: ObSpace.md) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 16))
                    .foregroundStyle(tone.text)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(s))
                        .font(ObFont.sub.weight(.medium))
                        .foregroundStyle(tone.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("파급 예측에서 한 번에 정리할 수 있어요")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Ob.text3)
            }
            .padding(ObSpace.md)
            .background(tone.soft, in: RoundedRectangle(cornerRadius: ObRadius.lg))
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.lg))
        }
        .buttonStyle(.plain)
        .accessibilityHint("해결하기")
    }

    private func title(_ s: ImpactSummary) -> String {
        var t = "기한 지난 작업 \(report.rootIds.count)개 때문에 "
        if s.delayedCount > 0 { t += "\(s.delayedCount)개 일정이 밀리고 있어요" }
        if s.delayedCount > 0, s.conflictCount > 0 { t += ", " }
        if s.conflictCount > 0 { t += "고정 일정 \(s.conflictCount)개가 위험해요" }
        return t
    }
}
