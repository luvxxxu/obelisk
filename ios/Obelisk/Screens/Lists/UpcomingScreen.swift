import SwiftUI

/// 예정 (web app/(app)/upcoming/page.tsx): the next two weeks day by day, later work by month, or the
/// whole plan as a draggable timeline. The choice is remembered (web usePref 'upcoming-mode').
struct UpcomingScreen: View {
    @Environment(AppStore.self) private var store
    @AppStorage("obelisk:upcoming-mode") private var mode: ListsViewMode = .list

    var body: some View {
        switch mode {
        case .list: list
        case .timeline: timeline
        }
    }

    // MARK: timeline

    private var timeline: some View {
        let active = store.taskList.filter { $0.isActive && ($0.dueDate != nil || $0.startDate != nil) }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                ListsHeader(
                    "예정",
                    description: "막대를 끌어 일정을 옮겨보세요. 밀리는 작업이 실시간으로 표시돼요.",
                    actions: { ListsModePicker(mode: $mode) }
                )
                ListsTimeline(tasks: active)
            }
        }
        .listsTimelineHost()
        .refreshable { await store.refresh() }
    }

    // MARK: list

    private struct Day: Identifiable {
        var id: ISODate { date }
        var index: Int
        var date: ISODate
        var tasks: [TaskItem]
    }

    private struct Month: Identifiable {
        var id: String { month }
        var month: String
        var tasks: [TaskItem]
    }

    private var list: some View {
        let today = store.today
        let (days, later) = agenda(today)
        let nothing = days.allSatisfy { $0.tasks.isEmpty } && later.isEmpty

        return List {
            ListsHeader(
                "예정",
                description: "앞으로 2주는 날짜별로, 그 이후는 월별로 보여드려요.",
                actions: { ListsModePicker(mode: $mode) }
            )
            .listsPlainRow()

            if nothing {
                EmptyState(
                    "예정된 작업이 없어요",
                    message: "날짜를 넣어 작업을 추가하면 여기에서 한눈에 볼 수 있어요. 예: “보고서 금요일”"
                ) {
                    ListsNewTaskButton(prefill: NewTask(title: "", dueDate: addDays(today, 1)))
                }
                .listsPlainRow()
            } else {
                ForEach(days) { d in
                    let rel = ListsText.dropWeekday(formatRelativeKo(d.date, today))
                    let short = formatShortKo(d.date)
                    let sub = subtitle(rel: rel, short: short)
                    if d.tasks.isEmpty {
                        if d.index < 7 {
                            ListsDayHeader(title: rel, date: sub, empty: true)
                                .listsPlainRow(horizontal: ObSpace.page)
                                .accessibilityLabel("\(rel) \(short) 일정 없음")
                        }
                    } else {
                        Section {
                            ForEach(d.tasks) { t in
                                TaskRow(task: t, showDate: .time)
                                    .obTaskListRow()
                            }
                        } header: {
                            ListsDayHeader(title: rel, date: sub, count: d.tasks.count)
                                .accessibilityLabel("\(rel) \(short), \(d.tasks.count)개")
                        }
                    }
                }

                if !later.isEmpty {
                    ListsDividerLabel(text: "2주 이후")
                        .listsPlainRow(horizontal: ObSpace.page)
                }

                ForEach(later) { g in
                    Section {
                        ForEach(g.tasks) { t in
                            TaskRow(task: t)
                                .obTaskListRow()
                        }
                    } header: {
                        ListsDayHeader(title: monthLabel(g.month, today), count: g.tasks.count)
                    }
                }
            }
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    private func agenda(_ today: ISODate) -> ([Day], [Month]) {
        let upcoming = selectView(store.taskList, .upcoming, today)
        let horizon = addDays(today, 14)
        var byDay: [ISODate: [TaskItem]] = [:]
        var laterMap: [String: [TaskItem]] = [:]
        for t in upcoming {
            guard let d = t.dueDate ?? t.startDate else { continue }
            if d <= horizon {
                byDay[d, default: []].append(t)
            } else {
                laterMap[String(d.prefix(7)), default: []].append(t)
            }
        }
        let days = (0 ..< 14).map { i -> Day in
            let d = addDays(today, i + 1)
            return Day(index: i, date: d, tasks: sortTasks(byDay[d] ?? []))
        }
        let later = laterMap.keys.sorted().map { Month(month: $0, tasks: sortTasks(laterMap[$0] ?? [])) }
        return (days, later)
    }

    /// "내일 11/15 (토)" · "화요일 11/18" · "11월 22일 토요일": never say the same thing twice.
    private func subtitle(rel: String, short: String) -> String {
        if ListsText.namesDate(rel) {
            let chars = Array(short)
            return chars.count >= 2 ? "\(chars[chars.count - 2])요일" : short
        }
        if rel.hasSuffix("요일") { return ListsText.dropWeekday(short) }
        return short
    }

    /// "12월", or "2027년 1월" outside this year.
    private func monthLabel(_ month: String, _ today: ISODate) -> String {
        let year = String(month.prefix(4))
        let m = Int(month.suffix(2)) ?? 0
        return (year != String(today.prefix(4)) ? "\(year)년 " : "") + "\(m)월"
    }
}
