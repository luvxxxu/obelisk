import SwiftUI

/// 인박스 (web app/(app)/inbox/page.tsx): open tasks without a project.
struct InboxScreen: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let list = selectView(store.taskList, .inbox, store.today)

        List {
            ListsHeader(
                "인박스",
                description: "프로젝트 없이 담아 둔 작업이에요. 떠오르는 대로 적고, 나중에 날짜와 프로젝트를 정해 주세요."
            )
            .listsPlainRow()

            TaskSection(nil, tasks: list, showProject: false)

            if list.isEmpty {
                EmptyState(
                    "인박스가 비어 있어요",
                    message: "머릿속에 떠다니는 일을 모두 여기에 꺼내 두세요. 정리는 나중에 해도 돼요."
                ) {
                    ListsNewTaskButton(prefill: NewTask(title: ""))
                }
                .listsPlainRow()
            }
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }
}
