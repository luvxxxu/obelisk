import SwiftUI

/// 완료 기록 (web app/(app)/logbook/page.tsx): finished tasks of the last 30 days, by the day they were done.
struct LogbookScreen: View {
    @Environment(AppStore.self) private var store

    private struct Day: Identifiable {
        var id: ISODate { date }
        var date: ISODate
        var tasks: [TaskItem]
    }

    var body: some View {
        let days = makeDays()
        let total = days.reduce(0) { $0 + $1.tasks.count }
        let today = store.today

        SelectableList(rows: days.flatMap(\.tasks).map(\.id)) {
            ListsHeader(
                "완료 기록",
                description: "최근 30일 동안 \(total)개를 끝냈어요. 동그라미를 다시 누르면 완료를 취소해요."
            )
            .listsPlainRow()

            ForEach(days) { d in
                let rel = formatRelativeKo(d.date, today)
                Section {
                    ForEach(d.tasks) { t in
                        TaskRow(task: t, showDate: .none)
                            .obTaskListRow()
                    }
                } header: {
                    // "오늘"/"어제" carry no date: show it next to them.
                    ListsDayHeader(
                        title: rel,
                        date: ListsText.namesDate(rel) ? nil : formatShortKo(d.date),
                        count: d.tasks.count
                    )
                }
            }

            if total == 0 {
                EmptyState(
                    "아직 완료한 작업이 없어요",
                    message: "작업 왼쪽의 동그라미를 누르거나 작업을 오른쪽으로 밀면 완료돼요."
                ) {
                    ListsPageButton(title: "오늘 할 일 보기", symbol: "sun.max", page: .today)
                }
                .listsPlainRow()
            }
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    private func makeDays() -> [Day] {
        let tz = store.timezone
        var map: [ISODate: [TaskItem]] = [:]
        for t in store.taskList where t.status == .done {
            guard let d = completedOn(t, tz) else { continue }
            map[d, default: []].append(t)
        }
        return map.keys.sorted(by: >).map { Day(date: $0, tasks: map[$0]!.listsByCompletion()) }
    }
}
