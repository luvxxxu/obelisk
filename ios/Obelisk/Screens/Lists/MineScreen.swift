import SwiftUI

/// 내 작업 (web app/(app)/mine/page.tsx): what is assigned to me in this organization, plus what I
/// handed to others. In the personal space it explains itself instead.
struct MineScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.isOrg {
            ListsMinuteClock { now in MineContent(now: now) }
        } else {
            ScrollView {
                EmptyState(
                    "내 작업은 조직에서 쓰는 보기예요",
                    message: "조직에서는 작업마다 담당자를 정할 수 있고, 여기에 내가 맡은 작업이 모여요."
                ) {
                    ListsPageButton(title: "전체 작업 보기", symbol: "square.stack.3d.up", page: .all)
                }
                .padding(.top, ObSpace.xxxl)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(Ob.bg)
        }
    }
}

private struct MineContent: View {
    var now: Clock
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    private struct Delegated: Identifiable {
        /// The sorted ids joined, so the same people make one group whatever order they were added in.
        var id: String
        /// Who, in the order the group's first task lists them.
        var people: [String]
        var tasks: [TaskItem]
    }

    var body: some View {
        let today = store.today
        let me = store.user?.id
        let tasks = store.taskList
        let mine = sortTasks(tasks.filter { $0.isActive && $0.isAssigned(to: me) })
        let overdue = mine.filter { isOverdue($0, today, now) }
        let current = mine.filter { !isOverdue($0, today, now) && isToday($0, today) }
        let later = mine.filter { !isToday($0, today) && ($0.startDate != nil || $0.dueDate != nil) }
        let undated = mine.filter { $0.startDate == nil && $0.dueDate == nil }
        let done = Array(tasks.filter { $0.status == .done && $0.isAssigned(to: me) }.listsByCompletion().prefix(30))
        let delegated = delegatedGroups(tasks, me: me)
        let name = store.workspace?.name ?? ""
        let selection = router.selection
        let rows = (overdue + current + later + undated).map(\.id)
            + delegated.flatMap { selection.shown("delegated:\($0.id)", $0.tasks, collapsedByDefault: true) }
            + selection.shown("최근 완료", done, collapsedByDefault: true)

        SelectableList(rows: rows) {
            ListsHeader(
                "내 작업",
                description: "\(name)에서 내가 맡은 작업 \(mine.count)개" + (overdue.isEmpty ? "" : " · 기한 지남 \(overdue.count)개")
            )
            .listsPlainRow()

            TaskSection("기한 지남", tasks: overdue, tone: .danger)
            TaskSection("오늘", tasks: current)
            TaskSection("예정", tasks: later)
            TaskSection("날짜 없음", tasks: undated)

            if mine.isEmpty {
                EmptyState(
                    "맡은 작업이 없어요",
                    message: "작업 상세에서 담당자를 나로 지정하거나, 아래 입력창에서 바로 추가해 보세요."
                )
                .listsPlainRow()
            }

            ForEach(delegated) { g in
                let who = g.people.map { store.memberName($0) ?? "전 멤버" }.joined(separator: ", ")
                ListsGroup(tasks: g.tasks, accessibilityTitle: "\(who)에게 맡긴 작업", foldKey: "delegated:\(g.id)", defaultCollapsed: true) {
                    HStack(spacing: ObSpace.sm) {
                        AvatarStack(names: g.people.map { store.memberName($0) ?? "전 멤버" }, size: 20)
                        Text("\(who)에게 맡긴 작업").lineLimit(1)
                    }
                }
            }

            TaskSection("최근 완료", tasks: done, collapsible: true, defaultCollapsed: true)
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    /// Open tasks I created and gave to other people (without me), grouped by who has them (first
    /// appearance order), as on the web.
    private func delegatedGroups(_ tasks: [TaskItem], me: String?) -> [Delegated] {
        guard let me else { return [] }
        let list = sortTasks(tasks.filter { $0.isActive && $0.createdBy == me && !$0.assigneeIds.isEmpty && !$0.isAssigned(to: me) })
        var groups: [Delegated] = []
        var index: [String: Int] = [:]
        for t in list {
            let key = t.assigneeIds.sorted().joined(separator: ",")
            if let i = index[key] {
                groups[i].tasks.append(t)
            } else {
                index[key] = groups.count
                groups.append(Delegated(id: key, people: t.assigneeIds, tasks: [t]))
            }
        }
        return groups
    }
}
