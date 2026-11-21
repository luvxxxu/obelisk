import SwiftUI

/// 전체 작업 (web app/(app)/all/page.tsx): every open task, grouped by project (인박스 first), each group
/// collapsible with a link to its page.
struct AllScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    private struct Group: Identifiable {
        var id: String
        var project: Project?
        var name: String
        var tasks: [TaskItem]
    }

    var body: some View {
        let groups = makeGroups()
        let total = groups.reduce(0) { $0 + $1.tasks.count }
        let rows = groups.flatMap { router.selection.shown("group:\($0.id)", $0.tasks, collapsedByDefault: false) }

        SelectableList(rows: rows) {
            ListsHeader(
                "전체 작업",
                description: "진행 중인 작업 \(total)개를 프로젝트별로 모았어요. 머리글을 눌러 접거나 펼칠 수 있어요."
            )
            .listsPlainRow()

            ForEach(groups) { g in
                ListsGroup(tasks: g.tasks, accessibilityTitle: g.name, foldKey: "group:\(g.id)", showProject: false) {
                    HStack(spacing: ObSpace.sm) {
                        if let p = g.project {
                            ProjectSwatch(color: p.color, size: 9)
                        } else {
                            Image(systemName: "tray")
                                .font(.system(size: 12))
                                .foregroundStyle(Ob.text3)
                        }
                        Text(g.name)
                    }
                } aside: {
                    AllOpenLink(name: g.name, page: g.project.map { .project($0.id) } ?? .inbox)
                }
            }

            if groups.isEmpty {
                EmptyState(
                    "진행 중인 작업이 없어요",
                    message: "새 작업을 추가해보세요. “#프로젝트”를 붙이면 프로젝트별로 정리돼요."
                ) {
                    ListsNewTaskButton(prefill: NewTask(title: ""))
                }
                .listsPlainRow()
            }
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    private func makeGroups() -> [Group] {
        let active = selectView(store.taskList, .all, store.today)
        var byProject: [String: [TaskItem]] = [:]
        for t in active { byProject[t.projectId ?? "", default: []].append(t) }
        var out: [Group] = [Group(id: "inbox", project: nil, name: "인박스", tasks: byProject[""] ?? [])]
        out += store.openProjects.map { Group(id: $0.id, project: $0, name: $0.name, tasks: byProject[$0.id] ?? []) }
        return out.filter { !$0.tasks.isEmpty }
    }
}

/// "열기 ↗" next to a group title (the text drops on phones, like the web under 480px).
private struct AllOpenLink: View {
    var name: String
    var page: Page
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            router.open(page)
        } label: {
            Image(systemName: "arrow.up.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Ob.text3)
                .frame(width: ObSize.row, height: ObSize.row)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, -ObSpace.md)
        .accessibilityLabel("\(name) 열기")
    }
}
