import SwiftUI

/// A day with at least this many tasks is called out under the week strip.
private let OVERVIEW_BUSY_DAY = 3

/// 모아보기 (web app/(app)/overview/page.tsx): the user's own work in every space at once: all of the
/// personal space and what is assigned to them in each organization. Overdue · today · the next 7 days
/// (with how the load spreads across spaces) · fixed commitments within 30 days. Ticking works in place;
/// opening a task of another space switches to it with the task open.
struct OverviewScreen: View {
    @Environment(AppStore.self) private var store
    private let feed = OverviewFeed.shared
    /// The user's wall clock, ticked on the minute ("40분 지남" on rows with a due time).
    @State private var now = clockNow()

    struct Day: Identifiable {
        var date: ISODate
        var items: [OverviewItem]
        var id: ISODate { date }
    }

    struct Sections {
        var overdue: [OverviewItem]
        var today: [OverviewItem]
        var week: [Day]
        var fixed: [(item: OverviewItem, date: ISODate)]
    }

    var body: some View {
        let merged = feed.merged(store)
        let today = store.today
        let spaces = merged.spaces
        let hues = spaceHues(spaces)
        let multi = spaces.count > 1
        let shown = merged.items.filter { !feed.hidden.contains($0.space.id) }
        let sections = Self.sections(shown, today)
        let perSpace = merged.items.reduce(into: [String: Int]()) { $0[$1.space.id, default: 0] += 1 }
        let listed = sections.overdue.count + sections.today.count + sections.week.reduce(0) { $0 + $1.items.count }
        let visibleSpaces = spaces.filter { !feed.hidden.contains($0.id) }
        let nothing = listed == 0 && sections.fixed.isEmpty
        let loaded = feed.loaded(for: store)
        let error = feed.errorText(for: store)

        ScrollViewReader { proxy in
            List {
                Section {
                    header(today: today, multi: multi, spaces: visibleSpaces.count, listed: listed, overdue: sections.overdue.count)
                        .overviewTopRow()
                    if multi {
                        chips(spaces, hues: hues, perSpace: perSpace, loading: !loaded && error == nil)
                            .overviewTopRow(bottom: ObSpace.lg)
                    } else if loaded {
                        callout("building.2", "지금은 개인 공간만 있어요. 조직에 참여하면 그곳에서 나에게 배정된 일도 여기에 함께 모여요.", tone: .neutral)
                            .overviewTopRow(bottom: ObSpace.lg)
                    }
                    if let error {
                        callout("exclamationmark.triangle", "다른 공간을 불러오지 못했어요 · \(error)", tone: .danger)
                            .overviewTopRow(bottom: ObSpace.lg)
                    }
                    if !visibleSpaces.isEmpty {
                        OverviewWeekLoad(
                            today: today, spaces: visibleSpaces, hues: hues,
                            days: [Day(date: today, items: sections.overdue + sections.today)] + sections.week
                        ) { date in
                            withAnimation(ObMotion.mid) { proxy.scrollTo("ov-day-\(date)", anchor: .top) }
                        }
                        .overviewTopRow(bottom: ObSpace.xs)
                    }
                }

                if visibleSpaces.isEmpty {
                    EmptyState("모든 공간을 숨겼어요", message: "위에서 공간을 눌러 다시 켜 보세요.")
                        .overviewTopRow()
                } else if nothing, loaded {
                    EmptyState(
                        "모든 공간이 조용해요",
                        message: "기한 지난 일도, \(OVERVIEW_DAYS)일 안에 할 일도 없어요. \(multi ? "조직 작업은 나에게 배정된 것만 모여요." : "")"
                    )
                    .overviewTopRow()
                } else {
                    if !sections.overdue.isEmpty {
                        Section {
                            ForEach(sections.overdue) { i in
                                OverviewRow(item: i, today: today, hues: hues, multi: multi, mode: .overdue, now: now)
                            }
                        } header: {
                            groupHeader("기한 지남", count: sections.overdue.count, tone: .danger)
                        }
                    }

                    Section {
                        if sections.today.isEmpty {
                            Text("오늘 남은 일이 없어요.")
                                .font(ObFont.sub)
                                .foregroundStyle(Ob.text3)
                                .padding(.vertical, ObSpace.sm)
                                .obTaskListRow()
                                .id("ov-day-\(today)")
                        } else {
                            ForEach(Array(sections.today.enumerated()), id: \.element.id) { n, i in
                                OverviewRow(item: i, today: today, hues: hues, multi: multi, mode: .span, now: now)
                                    .id(n == 0 ? "ov-day-\(today)" : i.id)
                            }
                        }
                    } header: {
                        groupHeader("오늘", count: sections.today.count, hint: "진행 중인 작업 포함")
                    }

                    let days = sections.week.filter { !$0.items.isEmpty }
                    if !days.isEmpty {
                        Section {
                            ForEach(days) { d in
                                dayHead(d, today: today)
                                    .id("ov-day-\(d.date)")
                                ForEach(d.items) { i in
                                    OverviewRow(item: i, today: today, hues: hues, multi: multi, mode: .spanIfRange, now: now)
                                }
                            }
                        } header: {
                            groupHeader("앞으로 \(OVERVIEW_DAYS)일", count: days.reduce(0) { $0 + $1.items.count })
                        }
                    }

                    if !sections.fixed.isEmpty {
                        Section {
                            ForEach(sections.fixed, id: \.item.id) { f in
                                OverviewRow(item: f.item, today: today, hues: hues, multi: multi, mode: .fixed, fixedDate: f.date, now: now)
                            }
                        } header: {
                            groupHeader("고정 일정", count: sections.fixed.count, hint: "\(OVERVIEW_FIXED_DAYS)일 안")
                        }
                    }
                }
            }
            .obTaskList()
            .refreshable {
                await store.refresh()
                await feed.load(store)
            }
        }
        .task(id: store.user?.id) { await feed.keepFresh(store) }
        .task(id: store.timezone) {
            now = clockNow(store.timezone)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(nextMinuteDelay()))
                if Task.isCancelled { break }
                now = clockNow(store.timezone)
            }
        }
        .onChange(of: store.workspace?.id) { _, id in
            if id != nil { Task { await feed.load(store) } }
        }
    }

    // MARK: sections

    static func sections(_ items: [OverviewItem], _ today: ISODate) -> Sections {
        var byId: [String: OverviewItem] = [:]
        for i in items { byId[i.task.id] = i }
        let sec = overviewSections(items.map(\.task), today)
        func pick(_ list: [TaskItem]) -> [OverviewItem] { list.compactMap { byId[$0.id] } }
        return Sections(
            overdue: pick(sec.overdue),
            today: pick(sec.today),
            week: sec.week.map { Day(date: $0.date, items: pick($0.tasks)) },
            fixed: sec.fixed.compactMap { f in byId[f.task.id].map { (item: $0, date: f.date) } }
        )
    }

    // MARK: pieces

    private func header(today: ISODate, multi: Bool, spaces: Int, listed: Int, overdue: Int) -> some View {
        let name = store.user?.name
        let lead = "\(longDateKo(today)) · \(multi ? "\(spaces)개 공간에서 " : "")\(name.map { "\($0)님이 " } ?? "")할 일 \(listed)개"
        return VStack(alignment: .leading, spacing: ObSpace.xs) {
            Text("모아보기")
                .font(ObFont.title)
                .foregroundStyle(Ob.text)
                .accessibilityAddTraits(.isHeader)
            Group {
                if overdue > 0 {
                    Text("\(lead)\(Text(" · 기한 지남 \(overdue)개").foregroundStyle(Ob.dangerText))")
                } else {
                    Text(lead)
                }
            }
            .font(ObFont.sub)
            .foregroundStyle(Ob.text3)
        }
        .padding(.top, ObSpace.sm)
        .padding(.bottom, ObSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func chips(_ spaces: [WorkspaceSummary], hues: [String: SpaceHue], perSpace: [String: Int], loading: Bool) -> some View {
        FlowRow(spacing: ObSpace.sm, lineSpacing: ObSpace.sm) {
            ForEach(spaces) { w in
                let on = !feed.hidden.contains(w.id)
                Button {
                    Haptics.select()
                    withAnimation(ObMotion.standard) { feed.toggleSpace(w.id) }
                } label: {
                    HStack(spacing: ObSpace.sm) {
                        Circle()
                            .fill(on ? (hues[w.id] ?? .slate).palette.ink : Color.clear)
                            .overlay { if !on { Circle().strokeBorder(Ob.text4, lineWidth: 1.5) } }
                            .frame(width: 8, height: 8)
                        HomeSpaceMark(space: w, size: 20)
                        Text(overviewSpaceLabel(w))
                            .font(ObFont.footnote.weight(.medium))
                            .lineLimit(1)
                        Text("\(perSpace[w.id] ?? 0)")
                            .font(ObFont.footnote.monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        if !on {
                            Image(systemName: "eye.slash")
                                .font(.system(size: 12))
                                .foregroundStyle(Ob.text3)
                        }
                    }
                    .foregroundStyle(on ? Ob.text : Ob.text3)
                    .padding(.leading, 10)
                    .padding(.trailing, ObSpace.md)
                    .frame(minHeight: ObSize.control)
                    .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.border, lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: ObRadius.md))
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityHint(on ? "이 공간 숨기기" : "이 공간 보이기")
            }
            if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("다른 공간 불러오는 중")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
                .frame(minHeight: ObSize.control)
            }
        }
    }

    private func callout(_ symbol: String, _ text: String, tone: Tone) -> some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(tone == .neutral ? Ob.text2 : tone.ink)
                .padding(.top, 1)
            Text(text)
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(ObSpace.md)
        .background(tone == .neutral ? Ob.tint : tone.soft, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .accessibilityElement(children: .combine)
    }

    private func groupHeader(_ title: String, count: Int, tone: Tone = .neutral, hint: String? = nil) -> some View {
        HStack(spacing: ObSpace.sm) {
            SectionLabel(title, count: count > 0 ? count : nil, tone: tone)
                .fixedSize()
            if let hint {
                Text(hint)
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
            }
            Spacer(minLength: 0)
        }
        .textCase(nil)
        .padding(.top, ObSpace.sm)
    }

    private func dayHead(_ d: Day, today: ISODate) -> some View {
        let parts = d.date.split(separator: "-").compactMap { Int($0) }
        let label = parts.count == 3 ? "\(parts[1])/\(parts[2]) \(WEEKDAYS_KO[weekday(d.date)])" : d.date
        return HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
            Text(formatRelativeKo(d.date, today))
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(Ob.text)
            Text(label)
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.text3)
            Spacer(minLength: 0)
            Text("\(d.items.count)")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.text3)
        }
        .padding(.top, ObSpace.md)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
        .listRowBackground(Ob.bg)
        .listRowSeparatorTint(Ob.border)
        .environment(\.defaultMinListRowHeight, 0)
    }
}

private extension View {
    /// A full-width row above the task groups: no separator, page insets.
    func overviewTopRow(bottom: CGFloat = 0) -> some View {
        self
            .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: bottom, trailing: ObSpace.page))
            .listRowSeparator(.hidden)
            .listRowBackground(Ob.bg)
    }
}

// MARK: - week load

/// How the next days fill up, per space: a column per day (today includes what is overdue) with one
/// segment per space; tapping a day scrolls to it. The busiest day ahead is called out underneath.
private struct OverviewWeekLoad: View {
    var today: ISODate
    var spaces: [WorkspaceSummary]
    var hues: [String: SpaceHue]
    var days: [OverviewScreen.Day]
    var jump: (ISODate) -> Void

    private struct Col: Identifiable {
        var date: ISODate
        var total: Int
        var counts: [(space: WorkspaceSummary, n: Int)]
        var id: ISODate { date }
    }

    var body: some View {
        let cols = days.map { d in
            Col(
                date: d.date,
                total: d.items.count,
                counts: spaces.map { w in (space: w, n: d.items.filter { $0.space.id == w.id }.count) }.filter { $0.n > 0 }
            )
        }
        let maxTotal = max(1, cols.map(\.total).max() ?? 0)
        // Today already has its own list; the note is about a day ahead where work piles up.
        let busy = cols.dropFirst().reduce(nil as Col?) { best, c in
            c.total >= OVERVIEW_BUSY_DAY && c.total > (best?.total ?? 0) ? c : best
        }

        VStack(alignment: .leading, spacing: 0) {
            Hairline()
            HStack(spacing: 2) {
                ForEach(cols) { c in
                    column(c, max: maxTotal, busy: busy?.date == c.date)
                }
            }
            .padding(.vertical, ObSpace.sm)
            if let busy {
                Hairline()
                let when = formatRelativeKo(busy.date, today)
                let particle = when == "내일" || when == "모레" ? " " : "에 "
                let spread = busy.counts.count > 1
                    ? " · " + busy.counts.map { "\(overviewSpaceLabel($0.space)) \($0.n)" }.joined(separator: ", ")
                    : ""
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Image(systemName: "bolt")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Ob.warn)
                    Text("\(Text(when).fontWeight(.semibold).foregroundStyle(Ob.text))\(particle)\(busy.total)개가 몰려 있어요\(spread)")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, ObSpace.md)
            }
            Hairline()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("날짜별 할 일 수")
    }

    private func column(_ c: Col, max maxTotal: Int, busy: Bool) -> some View {
        let isToday = c.date == today
        let wd = weekday(c.date)
        let weekend = wd == 0 || wd == 6
        let breakdown = c.counts.map { "\(overviewSpaceLabel($0.space)) \($0.n)" }.joined(separator: " · ")
        let barHeight: CGFloat = 44
        let stack = c.total > 0 ? max(6, barHeight * CGFloat(c.total) / CGFloat(maxTotal)) : 0
        let gaps = CGFloat(max(0, c.counts.count - 1)) * 2

        return Button {
            jump(c.date)
        } label: {
            VStack(spacing: ObSpace.xs) {
                Text(c.total > 0 ? "\(c.total)" : " ")
                    .font(ObFont.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(busy ? Ob.warnText : Ob.text)
                    .frame(height: 16)
                ZStack(alignment: .bottom) {
                    Rectangle()
                        .fill(Ob.border)
                        .frame(width: 28, height: 1)
                    if c.total > 0 {
                        VStack(spacing: 2) {
                            ForEach(c.counts.reversed(), id: \.space.id) { x in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill((hues[x.space.id] ?? .slate).palette.ink)
                                    .frame(height: max(2, (stack - gaps) * CGFloat(x.n) / CGFloat(c.total)))
                            }
                        }
                        .frame(width: 18, height: stack, alignment: .bottom)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: barHeight, alignment: .bottom)
                Text(isToday ? "오늘" : WEEKDAYS_KO[wd])
                    .font(ObFont.caption.weight(isToday ? .semibold : .medium))
                    .foregroundStyle(isToday ? Ob.text : weekend ? Ob.text3 : Ob.text2)
                    .padding(.top, 2)
                Text("\(Int(c.date.suffix(2)) ?? 0)")
                    .font(ObFont.micro.monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
            .padding(.top, ObSpace.xs)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity)
            .background(busy ? Ob.tint : Color.clear, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.md))
        }
        .buttonStyle(.obRow)
        .disabled(c.total == 0)
        .accessibilityLabel("\(isToday ? "오늘(기한 지남 포함)" : formatRelativeKo(c.date, today)) \(c.total)개\(breakdown.isEmpty ? "" : ": \(breakdown)")")
    }
}

// MARK: - rows

enum OverviewDateMode { case overdue, span, spanIfRange, fixed }

/// One task of 모아보기: the shared task row's look plus the space it lives in. Tapping opens it (switching
/// to its space when needed); ticking completes it in its own space.
private struct OverviewRow: View {
    var item: OverviewItem
    var today: ISODate
    var hues: [String: SpaceHue]
    var multi: Bool
    var mode: OverviewDateMode
    var fixedDate: ISODate?
    var now: Clock

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var completing = false

    var body: some View {
        let task = item.task
        let spaceName = overviewSpaceLabel(item.space)

        HStack(alignment: .top, spacing: 0) {
            TaskCheckbox(
                status: completing ? .done : task.status,
                priority: task.priority,
                disabled: !item.editable,
                onToggle: complete
            )
            .padding(.leading, -11 + ObSpace.xs)
            .padding(.top, -1)

            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(ObFont.body)
                    .foregroundStyle(completing ? Ob.text3 : Ob.text)
                    .strikethrough(completing, color: Ob.text4)
                    .lineLimit(2)
                meta(spaceName, now: now)
            }
            .padding(.vertical, 11)
            // A concrete width, so the meta line wraps inside the row instead of overflowing it.
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, ObSpace.sm)
            Image(systemName: item.live ? "chevron.right" : "arrow.up.right")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Ob.text4)
                .padding(.top, 15)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { open() }
        .obTaskListRow()
        .accessibilityElement(children: .combine)
        .accessibilityHint(item.live ? "열기" : "\(spaceName)에서 열기")
        .accessibilityAction(named: "완료") { complete() }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if item.editable {
                Button {
                    complete()
                } label: {
                    Label("완료", systemImage: "checkmark")
                }
                .tint(Ob.ok)
            }
        }
        .contextMenu {
            Button {
                open()
            } label: {
                Label(item.live ? "열기" : "\(spaceName)에서 열기", systemImage: item.live ? "arrow.up.right" : "arrow.up.right.square")
            }
            if item.editable {
                Button {
                    complete()
                } label: {
                    Label("완료", systemImage: "checkmark.circle")
                }
            }
        }
    }

    /// The meta line as one wrapping Text (date · 고정 · 보기 전용 · project · space): a List measures its
    /// height reliably, which a custom wrapping layout doesn't get in every pass.
    @ViewBuilder
    private func meta(_ spaceName: String, now: Clock) -> some View {
        if let text = metaText(spaceName, now: now) {
            text
                .font(ObFont.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHint(item.task.fixed ? "고정 일정: 날짜가 움직이지 않아요" : "")
        }
    }

    private func metaText(_ spaceName: String, now: Clock) -> Text? {
        let task = item.task
        let (label, tone) = dateLabel(now)
        var parts: [Text] = []
        if let label {
            let color = tone == .overdue ? Ob.dangerText : tone == .today ? Ob.text : Ob.text3
            let weight: Font.Weight = tone == .overdue || tone == .today ? .medium : .regular
            let pin = task.fixed ? Text("\(Self.symbol("pin"))\u{00A0}") : Text("")
            parts.append(Text("\(pin)\(label)").fontWeight(weight).foregroundStyle(color))
        } else if task.fixed, mode != .fixed {
            parts.append(Text("\(Self.symbol("pin"))\u{00A0}고정").foregroundStyle(Ob.text3))
        }
        if !item.editable {
            parts.append(Text("\(Self.symbol("eye"))\u{00A0}보기 전용").foregroundStyle(Ob.text3))
        }
        if let p = item.project {
            parts.append(Text("\(Self.dot("square.fill", p.color.palette.ink))\u{00A0}\(p.name)").foregroundStyle(Ob.text3))
        }
        if multi {
            parts.append(Text("\(Self.dot("circle.fill", (hues[item.space.id] ?? .slate).palette.ink))\u{00A0}\(spaceName)").foregroundStyle(Ob.text3))
        }
        guard let first = parts.first else { return nil }
        return parts.dropFirst().reduce(first) { acc, p in Text("\(acc)\u{2002}\u{2002}\(p)") }
    }

    private static func symbol(_ name: String) -> Text {
        Text(Image(systemName: name)).font(.system(size: 10))
    }

    /// A small swatch inside text: square for a project, round for a space (they never read alike).
    private static func dot(_ name: String, _ color: Color) -> Text {
        Text(Image(systemName: name)).font(.system(size: 7)).foregroundStyle(color).baselineOffset(1.5)
    }

    private enum LabelTone { case overdue, today, plain }

    /// Same date language as the shared task row: overdue red, today bold, the rest muted.
    private func dateLabel(_ now: Clock) -> (String?, LabelTone) {
        let task = item.task
        switch mode {
        case .overdue:
            if let due = task.dueDate { return (overdueLabel(due, today, task.dueTime, now), .overdue) }
        case .span:
            return (spanLabel(task, today), .today)
        case .spanIfRange:
            if let s = task.startDate, let d = task.dueDate, s != d { return (spanLabel(task, today), .plain) }
        case .fixed:
            if let fixedDate { return (formatRelativeKo(fixedDate, today), fixedDate == today ? .today : .plain) }
        }
        return (nil, .plain)
    }

    private func complete() {
        guard item.editable else {
            store.toasts.error(AppStore.readOnlyMessage)
            return
        }
        guard !completing else { return }
        withAnimation(ObMotion.standard) { completing = true }
        let item = self.item
        let store = self.store
        Task {
            try? await Task.sleep(for: .milliseconds(380))
            await OverviewFeed.shared.complete(item, store: store)
            completing = false
        }
    }

    private func open() {
        if item.live {
            router.openTask(item.task.id)
            return
        }
        let spaceName = overviewSpaceLabel(item.space)
        let store = self.store
        let router = self.router
        let id = item.task.id
        Task {
            if let resolved = await store.resolveTaskLink(id) {
                router.openTask(resolved)
                store.toasts.show("\(spaceName)(으)로 전환했어요")
            } else {
                store.toasts.error("작업을 찾을 수 없어요")
            }
        }
    }
}
