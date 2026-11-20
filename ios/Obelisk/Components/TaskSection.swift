import SwiftUI

/// A titled group of task rows inside a `List` (web View.tsx TaskGroup): optional title with count and
/// tone, optional collapse, an aside on the right, and an empty line when there is nothing.
///
///     List {
///         TaskSection("기한 지남", tasks: overdue, tone: .danger)
///         TaskSection(nil, tasks: todays)
///     }
///     .obTaskList()
struct TaskSection<Aside: View>: View {
    var title: String?
    var tasks: [TaskItem]
    var tone: Tone = .neutral
    var showProject = true
    var showDate: TaskRow.DateDisplay = .full
    var collapsible = false
    var empty: String?
    @ViewBuilder var aside: () -> Aside

    @State private var collapsed: Bool

    init(
        _ title: String?,
        tasks: [TaskItem],
        tone: Tone = .neutral,
        showProject: Bool = true,
        showDate: TaskRow.DateDisplay = .full,
        collapsible: Bool = false,
        defaultCollapsed: Bool = false,
        empty: String? = nil,
        @ViewBuilder aside: @escaping () -> Aside = { EmptyView() }
    ) {
        self.title = title
        self.tasks = tasks
        self.tone = tone
        self.showProject = showProject
        self.showDate = showDate
        self.collapsible = collapsible
        self.empty = empty
        self.aside = aside
        _collapsed = State(initialValue: defaultCollapsed)
    }

    var body: some View {
        if !tasks.isEmpty || empty != nil {
            Section {
                if !collapsed {
                    ForEach(tasks) { t in
                        TaskRow(task: t, showProject: showProject, showDate: showDate)
                            .obTaskListRow()
                    }
                    if tasks.isEmpty, let empty {
                        Text(empty)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                            .padding(.vertical, ObSpace.sm)
                            .obTaskListRow()
                    }
                }
            } header: {
                if let title { header(title) }
            }
        }
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: ObSpace.sm) {
            if collapsible {
                Button {
                    withAnimation(ObMotion.standard) { collapsed.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(collapsed ? 0 : 90))
                            .foregroundStyle(Ob.text3)
                        label(title)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(collapsed ? "접힘" : "펼침")
            } else {
                label(title)
            }
            Spacer(minLength: 0)
            aside()
        }
        .textCase(nil)
        .padding(.top, ObSpace.sm)
    }

    private func label(_ title: String) -> some View {
        SectionLabel(title, count: tasks.isEmpty ? nil : tasks.count, tone: tone)
    }
}

extension View {
    /// Row insets/background for task rows in an Obelisk list: pure background, hairline separators
    /// inset to the title.
    func obTaskListRow() -> some View {
        self
            .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
            .listRowBackground(Ob.bg)
            .listRowSeparatorTint(Ob.border)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 34 }
    }

    /// A plain, pure-background List for tasks (use with TaskSection / TaskRow).
    func obTaskList() -> some View {
        self
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Ob.bg)
            .environment(\.defaultMinListRowHeight, ObSize.row)
            .listSectionSpacing(ObSpace.md)
    }
}
