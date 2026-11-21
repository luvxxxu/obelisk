import SwiftUI

// Shared pieces of the list pages (web View.tsx + views.module.css): the page header with actions on the
// title row, collapsible groups with a custom title, agenda day headers, the 리스트 · 타임라인 switch,
// the empty-state buttons and the minute clock.

// MARK: - Page header (web ViewHeader)

/// Title row (title + actions on the right), one muted line under it, then optional extras (stats).
/// Unlike `PageHeader`, the description runs the full width under the actions, the way the web lays it out.
struct ListsHeader<Title: View, Actions: View, Extra: View>: View {
    var description: String?
    @ViewBuilder var title: () -> Title
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var extra: () -> Extra

    init(
        description: String? = nil,
        @ViewBuilder title: @escaping () -> Title,
        @ViewBuilder actions: @escaping () -> Actions = { EmptyView() },
        @ViewBuilder extra: @escaping () -> Extra = { EmptyView() }
    ) {
        self.description = description
        self.title = title
        self.actions = actions
        self.extra = extra
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            HStack(alignment: .center, spacing: ObSpace.md) {
                title()
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions()
            }
            .frame(minHeight: ObSize.control)
            if let description {
                Text(description)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            extra()
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.sm)
        .padding(.bottom, ObSpace.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ListsHeader where Title == ListsTitleText {
    init(
        _ title: String,
        description: String? = nil,
        @ViewBuilder actions: @escaping () -> Actions = { EmptyView() },
        @ViewBuilder extra: @escaping () -> Extra = { EmptyView() }
    ) {
        self.init(description: description, title: { ListsTitleText(text: title) }, actions: actions, extra: extra)
    }
}

/// The 28pt page title.
struct ListsTitleText: View {
    var text: String
    var body: some View {
        Text(text)
            .font(ObFont.title)
            .foregroundStyle(Ob.text)
            .lineLimit(2)
    }
}

extension View {
    /// A full-width row in an Obelisk task list with no insets and no separator (headers, callouts, empty
    /// states). Never picked in 선택 모드, even when a `ForEach` tags it (예정's empty days).
    func listsPlainRow(top: CGFloat = 0, bottom: CGFloat = 0, horizontal: CGFloat = 0) -> some View {
        self
            .listRowInsets(EdgeInsets(top: top, leading: horizontal, bottom: bottom, trailing: horizontal))
            .listRowSeparator(.hidden)
            .listRowBackground(Ob.bg)
            .selectionDisabled()
    }
}

// MARK: - Groups (web TaskGroup with a rich title)

/// A titled, optionally collapsible group of task rows whose title is a view (avatar, project swatch…).
struct ListsGroup<Label: View, Aside: View>: View {
    var tasks: [TaskItem]
    var showProject = true
    var showDate: TaskRow.DateDisplay = .full
    var collapsible = true
    var defaultCollapsed = false
    var accessibilityTitle: String
    /// What the fold is remembered under: the group's id where names can repeat (two projects both
    /// called "정리"), else the title.
    var foldKey: String
    @ViewBuilder var label: () -> Label
    @ViewBuilder var aside: () -> Aside

    @Environment(Router.self) private var router

    /// The fold lives in `router.selection` (keyed by `foldKey`), like TaskSection's.
    private var collapsed: Bool {
        guard collapsible else { return defaultCollapsed }
        return router.selection.isCollapsed(foldKey, default: defaultCollapsed)
    }

    init(
        tasks: [TaskItem],
        accessibilityTitle: String,
        foldKey: String? = nil,
        showProject: Bool = true,
        showDate: TaskRow.DateDisplay = .full,
        collapsible: Bool = true,
        defaultCollapsed: Bool = false,
        @ViewBuilder label: @escaping () -> Label,
        @ViewBuilder aside: @escaping () -> Aside = { EmptyView() }
    ) {
        self.tasks = tasks
        self.accessibilityTitle = accessibilityTitle
        self.foldKey = foldKey ?? accessibilityTitle
        self.showProject = showProject
        self.showDate = showDate
        self.collapsible = collapsible
        self.defaultCollapsed = defaultCollapsed
        self.label = label
        self.aside = aside
    }

    var body: some View {
        if !tasks.isEmpty {
            Section {
                if !collapsed {
                    ForEach(tasks) { t in
                        TaskRow(task: t, showProject: showProject, showDate: showDate)
                            .obTaskListRow()
                    }
                }
            } header: {
                header
                    .onAppear {
                        if collapsible { router.selection.keepDefault(foldKey, defaultCollapsed) }
                    }
            }
        }
    }

    private var header: some View {
        HStack(spacing: ObSpace.sm) {
            if collapsible {
                Button {
                    let folded = collapsed
                    withAnimation(ObMotion.standard) { router.selection.setCollapsed(foldKey, !folded) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(collapsed ? 0 : 90))
                            .foregroundStyle(Ob.text3)
                        titleLine
                    }
                    .frame(minHeight: ObSize.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(accessibilityTitle) \(tasks.count)개")
                .accessibilityValue(collapsed ? "접힘" : "펼침")
                .accessibilityAddTraits(.isHeader)
            } else {
                titleLine
                    .frame(minHeight: ObSize.row)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            aside()
        }
        .textCase(nil)
    }

    private var titleLine: some View {
        HStack(spacing: ObSpace.sm) {
            label()
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text)
                .lineLimit(1)
            Text("\(tasks.count)")
                .font(ObFont.footnote.monospacedDigit())
                .foregroundStyle(Ob.text3)
        }
    }
}

// MARK: - Agenda day header (예정 · 완료 기록)

/// "내일 11/20 (목)            3": sticky in the list as a section header.
struct ListsDayHeader: View {
    var title: String
    var date: String?
    var count: Int?
    /// 일정 없음 (a quiet, non-sticky line for an empty day).
    var empty = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
            Text(title)
                .font(empty ? ObFont.sub.weight(.medium) : ObFont.sub.weight(.semibold))
                .foregroundStyle(empty ? Ob.text3 : Ob.text)
                .lineLimit(1)
            if let date {
                Text(date)
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
            }
            Spacer(minLength: ObSpace.sm)
            if empty {
                Text("일정 없음")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
            } else if let count {
                Text("\(count)")
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
        }
        .frame(minHeight: empty ? 34 : 40)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// "2주 이후 ───────"
struct ListsDividerLabel: View {
    var text: String
    var body: some View {
        HStack(spacing: ObSpace.md) {
            Text(text)
                .font(ObFont.caption.weight(.medium))
                .foregroundStyle(Ob.text3)
            Hairline()
        }
        .padding(.top, ObSpace.xl)
        .padding(.bottom, ObSpace.xs)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - View switch (web ui.segmented 리스트 · 타임라인)

enum ListsViewMode: String, CaseIterable, Identifiable {
    case list, timeline
    var id: String { rawValue }
    var label: String { self == .list ? "리스트" : "타임라인" }
}

struct ListsModePicker: View {
    @Binding var mode: ListsViewMode

    var body: some View {
        Picker("보기 방식", selection: Binding(
            get: { mode },
            set: { m in
                Haptics.select()
                withAnimation(ObMotion.mid) { mode = m }
            }
        )) {
            ForEach(ListsViewMode.allCases) { m in
                Text(m.label).tag(m)
            }
        }
        .pickerStyle(.segmented)
        .fixedSize()
    }
}

// MARK: - Empty-state actions

/// The outline "새 작업" button of the web's empty states: opens the new-task sheet with this page's defaults.
struct ListsNewTaskButton: View {
    var prefill: NewTask
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: prefill) })
        } label: {
            ListsButtonLabel(title: "새 작업", symbol: "plus")
        }
        .buttonStyle(.ob(.outline, size: .small))
    }
}

/// An outline button that opens another sidebar page (다가오는 일정 보기 · 전체 작업 보기 · 오늘 할 일 보기).
struct ListsPageButton: View {
    var title: String
    var symbol: String
    var page: Page
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            router.open(page)
        } label: {
            ListsButtonLabel(title: title, symbol: symbol)
        }
        .buttonStyle(.ob(.outline, size: .small))
    }
}

/// Icon + text for the small pill buttons (a `Label` spaces them too far apart inside a pill).
struct ListsButtonLabel: View {
    var title: String
    var symbol: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
            Text(title)
        }
    }
}

// MARK: - Minute clock (web useClock)

/// Hands its content the user's wall clock, refreshed just after every minute boundary, so tasks due at a
/// time move to 기한 지남 the minute it passes. A ticking task instead of `TimelineView`: task rows with a
/// time run their own `TimelineView(.everyMinute)`, and nesting the two locked the screen up.
struct ListsMinuteClock<Content: View>: View {
    @ViewBuilder var content: (Clock) -> Content
    @Environment(AppStore.self) private var store
    @State private var now: Clock?

    var body: some View {
        content(now ?? clockNow(store.timezone))
            .task(id: store.timezone) {
                while !Task.isCancelled {
                    let next = clockNow(store.timezone)
                    if next != now { now = next }
                    try? await Task.sleep(for: .seconds(nextMinuteDelay()))
                }
            }
    }
}

// MARK: - Small helpers

enum ListsText {
    /// "11월 26일 (수)" → "11월 26일" (web `.replace(/ \(.\)$/, '')`).
    static func dropWeekday(_ s: String) -> String {
        s.replacingOccurrences(of: " \\(.\\)$", with: "", options: .regularExpression)
    }

    /// Whether a relative label already names a calendar date ("11월 26일").
    static func namesDate(_ s: String) -> Bool {
        s.range(of: "\\d월", options: .regularExpression) != nil
    }
}

extension Array where Element == TaskItem {
    /// Most recently completed first (ties by number for a stable order).
    func listsByCompletion() -> [TaskItem] {
        sorted { a, b in
            let x = a.completedAt ?? "", y = b.completedAt ?? ""
            return x != y ? x > y : a.number > b.number
        }
    }
}
