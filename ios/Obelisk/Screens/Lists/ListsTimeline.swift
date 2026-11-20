import SwiftUI

/*
 타임라인 (web components/Timeline.tsx) on iOS: a horizontally scrolling day grid with one bar per task
 (start…due), a pinned weekday header that follows the horizontal scroll, a fixed task column on the left,
 the today marker, weekend tints, dependency arrows (red and dashed when a successor starts before its
 predecessor ends) and a hatch on fixed dates.

 Long-press a bar to pick it up, then drag: the middle moves it, its ends resize it (fixed dates only move).
 It snaps by whole days with a selection tick per day; the tasks it would push slide along live with
 "+n일" / "n일 충돌", and a glass readout at the top says by how much and what it does. Dropping goes through
 `store.requestDateChange`, which asks first (impact sheet) when other work moves. Done and read-only
 tasks don't move; tapping any bar or label opens the task.

 Geometry: DAY_W 36 · ROW_H 44 (web 40, raised to the iOS touch target) · HEAD_H 52 · task column 132
 (web 130 on phones). Place it inside `LazyVStack(pinnedViews: [.sectionHeaders])` in a ScrollView that
 has `.listsTimelineHost()`: the header pins under the top bar and the host shows the drag readout.
 */
struct ListsTimeline: View {
    var tasks: [TaskItem]
    var emptyHint: String?

    init(tasks: [TaskItem], emptyHint: String? = nil) {
        self.tasks = tasks
        self.emptyHint = emptyHint
    }

    static let dayW: CGFloat = 36
    static let rowH: CGFloat = 44
    static let headH: CGFloat = 52
    static let labelW: CGFloat = 132
    static let barInset: CGFloat = 7
    /// Extra touch area outside each end of a bar (the resize handles).
    static let reach: CGFloat = 10
    fileprivate static let space = "obTimelineTracks"

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    @State private var drag: ListsTimelineDrag?
    @State private var preview: ListsTimelinePreview?
    /// The dropped span, shown until the store reflects it (no snap back for a frame).
    @State private var settling: (id: String, span: ListsSpan)?
    @State private var position = ScrollPosition(edge: .leading)
    /// Scroll geometry lives in an observable object so only the header strip follows every frame.
    @State private var scroll = ListsTimelineScroll()
    /// The finger's latest travel; kept out of view state so moving within a day re-renders nothing.
    @State private var track = ListsDragTrack()
    @State private var autoScroll: Task<Void, Never>?
    @GestureState private var pressing = false

    var body: some View {
        let m = ListsTimelineModel(tasks: tasks, today: store.today)
        Section {
            VStack(spacing: 0) {
                grid(m)
                footer(m)
            }
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
            .preference(key: ListsTimelineReadoutKey.self, value: readout(m))
        } header: {
            header(m)
                .dynamicTypeSize(...DynamicTypeSize.xLarge)
        }
    }

    // MARK: - header

    private func header(_ m: ListsTimelineModel) -> some View {
        HStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: ObSpace.xs) {
                Text("\(m.rows.count)개 작업")
                    .font(ObFont.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
                    .padding(.bottom, 9)
                Spacer(minLength: 0)
                Button {
                    Haptics.select()
                    withAnimation(ObMotion.mid) { position.scrollTo(x: m.homeX(viewport: scroll.viewport)) }
                } label: {
                    Text("오늘")
                        .font(ObFont.caption.weight(.medium))
                        .foregroundStyle(Ob.text2)
                        .padding(.horizontal, 10)
                        .frame(height: 26)
                        .overlay(Capsule().strokeBorder(Ob.border, lineWidth: 1))
                        .frame(minWidth: 44, minHeight: 44, alignment: .bottom)
                        .padding(.bottom, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("오늘 날짜로 스크롤")
            }
            .padding(.leading, ObSpace.md)
            .padding(.trailing, ObSpace.sm)
            .frame(width: Self.labelW, height: Self.headH, alignment: .bottom)

            Hairline(vertical: true)

            ListsTimelineHeaderStrip(scroll: scroll, dates: m.dates, today: m.today)
                .frame(height: Self.headH)
                .clipped()
                .accessibilityHidden(true)
        }
        .frame(height: Self.headH)
        .background(Ob.bg)
        .overlay(alignment: .top) { Hairline() }
        .overlay(alignment: .bottom) { Hairline() }
    }

    // MARK: - body

    private func grid(_ m: ListsTimelineModel) -> some View {
        let bodyH = max(CGFloat(m.rows.count) * Self.rowH, Self.rowH * 3)
        let impacts = impactMap()
        return HStack(alignment: .top, spacing: 0) {
            VStack(spacing: 0) {
                ForEach(m.rows) { t in label(t, impact: impacts[t.id]?.kind) }
            }
            .frame(width: Self.labelW, height: bodyH, alignment: .top)

            Hairline(vertical: true)

            ScrollView(.horizontal, showsIndicators: false) {
                tracks(m, impacts: impacts, height: bodyH)
                    .frame(width: m.width, height: bodyH, alignment: .topLeading)
                    .coordinateSpace(.named(Self.space))
            }
            .scrollPosition($position)
            .scrollDisabled(drag != nil)
            .onScrollGeometryChange(for: ListsScrollGeo.self) { g in
                ListsScrollGeo(x: g.contentOffset.x, viewport: g.containerSize.width, content: g.contentSize.width)
            } action: { _, g in
                scroll.update(g)
                if drag != nil { updateDelta() }
            }
            .onAppear { position.scrollTo(x: m.homeX(viewport: scroll.viewport)) }
            .onChange(of: m.start) { position.scrollTo(x: m.homeX(viewport: scroll.viewport)) }
            .onChange(of: scroll.viewport) { old, new in
                if old == 0, new > 0 { position.scrollTo(x: m.homeX(viewport: new)) }
            }
        }
        .frame(height: bodyH)
        .overlay(alignment: .center) {
            if m.rows.isEmpty {
                Text(emptyHint ?? "날짜가 있는 작업이 없어요. 작업에 시작일·마감일을 넣으면 여기에 그려져요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, ObSpace.xl)
                    .padding(.leading, Self.labelW)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: pressing) { _, now in
            // The gesture was cancelled (no onEnded): put everything back.
            if !now, drag != nil { cancelDrag() }
        }
        .onChange(of: store.revision) { settling = nil }
    }

    private func label(_ t: TaskItem, impact: ImpactKind?) -> some View {
        let p = store.project(t.projectId)
        let done = t.status == .done
        return Button {
            router.openTask(t.id)
        } label: {
            HStack(spacing: ObSpace.sm) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(p?.color.palette.ink ?? .clear)
                    .overlay {
                        if p == nil { RoundedRectangle(cornerRadius: 2).strokeBorder(Ob.borderStrong, lineWidth: 1.5) }
                    }
                    .frame(width: 8, height: 8)
                Text(t.title)
                    .font(ObFont.footnote)
                    .foregroundStyle(done ? Ob.text3 : Ob.text)
                    .strikethrough(done, color: Ob.text4)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if t.fixed {
                    Image(systemName: "pin")
                        .font(.system(size: 10))
                        .foregroundStyle(Ob.text3)
                        .accessibilityLabel("고정")
                }
            }
            .padding(.leading, ObSpace.md)
            .padding(.trailing, ObSpace.sm)
            .frame(height: Self.rowH)
            .background(impact == .shifted ? Ob.warnSoft : impact == .conflict ? Ob.dangerSoft : .clear)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(ListsTimelinePressStyle())
        .animation(ObMotion.fast, value: impact)
    }

    private func tracks(_ m: ListsTimelineModel, impacts: [String: TaskImpact], height: CGFloat) -> some View {
        let rowIndex = Dictionary(uniqueKeysWithValues: m.rows.enumerated().map { ($0.element.id, $0.offset) })
        let arrows = arrowList(m, rowIndex: rowIndex, impacts: impacts)
        let todayX = m.x(m.today)

        return ZStack(alignment: .topLeading) {
            ListsTimelineColumns(dates: m.dates, today: m.today, height: height)
                .equatable()

            // row lines
            VStack(spacing: 0) {
                ForEach(m.rows) { _ in
                    Color.clear.frame(height: Self.rowH).overlay(alignment: .bottom) { Hairline() }
                }
            }
            .frame(width: m.width, alignment: .top)
            .allowsHitTesting(false)

            // today
            Rectangle()
                .fill(Ob.text3)
                .frame(width: 1, height: height)
                .offset(x: todayX + Self.dayW / 2 - 0.5)
                .allowsHitTesting(false)

            // dependency arrows
            ForEach(arrows) { a in
                ZStack(alignment: .topLeading) {
                    ListsArrowShape(points: a.points)
                        .stroke(a.violated ? Ob.danger : Ob.text4, style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round, dash: a.violated ? [4, 3] : []))
                    ListsArrowHead(tip: a.points.last ?? .zero)
                        .fill(a.violated ? Ob.danger : Ob.text4)
                }
                .opacity(a.active ? 1 : 0.35)
            }
            .allowsHitTesting(false)

            ForEach(Array(m.rows.enumerated()), id: \.element.id) { i, t in
                bar(t, index: i, m: m, impact: impacts[t.id])
            }
        }
        .frame(width: m.width, height: height, alignment: .topLeading)
    }

    // MARK: - bars

    private func bar(_ t: TaskItem, index i: Int, m: ListsTimelineModel, impact im: TaskImpact?) -> some View {
        let orig = ListsSpan.of(t)!
        let live = liveSpan(t, impact: im)
        let isDragged = drag?.taskId == t.id
        let moved = live != orig
        let p = store.project(t.projectId)
        let ink = (p?.color ?? .slate).palette.ink
        let done = t.status == .done || t.status == .canceled
        let canDrag = !done && store.canEdit(t)
        let resizable = canDrag && !t.fixed
        let top = CGFloat(i) * Self.rowH + Self.barInset
        let barH = Self.rowH - Self.barInset * 2
        let width = CGFloat(diffDays(live.e, live.s) + 1) * Self.dayW - 6
        let overdue = !done && (t.dueDate.map { $0 < m.today } ?? false)

        return ZStack(alignment: .topLeading) {
            if moved {
                RoundedRectangle(cornerRadius: ObRadius.sm)
                    .fill(Ob.surface2.opacity(0.5))
                    .overlay(RoundedRectangle(cornerRadius: ObRadius.sm).strokeBorder(Ob.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                    .frame(width: CGFloat(diffDays(orig.e, orig.s) + 1) * Self.dayW - 6, height: barH)
                    .offset(x: m.x(orig.s) + 3, y: top)
                    .allowsHitTesting(false)
            }

            ListsTimelineBar(
                title: t.title,
                ink: ink,
                width: width,
                height: barH,
                fixed: t.fixed,
                done: done,
                overdue: overdue,
                kind: isDragged ? nil : im?.kind,
                lifted: isDragged,
                handles: resizable
            )
            .padding(.horizontal, Self.reach)
            .padding(.vertical, Self.barInset)
            .contentShape(Rectangle())
            .offset(x: m.x(live.s) + 3 - Self.reach, y: top - Self.barInset)
            .animation(isDragged ? ObMotion.fast : ObMotion.standard, value: live)
            .zIndex(isDragged ? 2 : 1)
            .gesture(barGesture(t, orig: orig, m: m, resizable: resizable), including: canDrag ? .all : .subviews)
            .simultaneousGesture(TapGesture().onEnded { if drag == nil { router.openTask(t.id) } })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(t.title)\(t.fixed ? ", 고정" : ""), \(ListsSpan.text(orig))")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { router.openTask(t.id) }
            .accessibilityActions {
                if canDrag {
                    Button("하루 미루기") { store.requestDateChange(t.id, AppStore.shiftSpan(t, 1)) }
                    Button("하루 앞당기기") { store.requestDateChange(t.id, AppStore.shiftSpan(t, -1)) }
                }
            }

            if !isDragged, let im, im.kind == .shifted || im.kind == .conflict {
                Text(im.kind == .shifted ? "+\(formatDaysKo(im.shiftDays))" : "\(formatDaysKo(im.overrunDays)) 충돌")
                    .font(ObFont.micro.weight(.semibold).monospacedDigit())
                    .foregroundStyle(im.kind == .shifted ? Ob.warnText : Ob.dangerText)
                    .padding(.horizontal, 4)
                    .frame(height: 18)
                    .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.xs))
                    .offset(x: m.x(live.e) + Self.dayW + 2, y: top + (barH - 18) / 2)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
    }

    private func liveSpan(_ t: TaskItem, impact im: TaskImpact?) -> ListsSpan {
        if let preview, preview.taskId == t.id, let s = ListsSpan.of(preview.next) { return s }
        if let settling, settling.id == t.id { return settling.span }
        if let im, im.kind == .shifted, let s = ListsSpan.of(im.to) { return s }
        return ListsSpan.of(t)!
    }

    private func impactMap() -> [String: TaskImpact] {
        var m: [String: TaskImpact] = [:]
        for im in preview?.p.report.impacts ?? [] { m[im.taskId] = im }
        return m
    }

    // MARK: - arrows

    private func arrowList(_ m: ListsTimelineModel, rowIndex: [String: Int], impacts: [String: TaskImpact]) -> [ListsArrow] {
        store.deps.compactMap { d -> ListsArrow? in
            guard let ri = rowIndex[d.dependsOnId], let si = rowIndex[d.taskId],
                  let pred = store.task(d.dependsOnId), let succ = store.task(d.taskId) else { return nil }
            let ps = liveSpan(pred, impact: impacts[pred.id])
            let ss = liveSpan(succ, impact: impacts[succ.id])
            let x1 = m.x(ps.e) + Self.dayW - 3
            let y1 = CGFloat(ri) * Self.rowH + Self.rowH / 2
            let x2 = m.x(ss.s) + 3
            let y2 = CGFloat(si) * Self.rowH + Self.rowH / 2
            let active = pred.isActive && succ.isActive
            let violated = active && ss.s < ps.e
            var pts: [CGPoint]
            if x2 - x1 >= 14 {
                let mx = x1 + 7
                pts = [CGPoint(x: x1, y: y1), CGPoint(x: mx, y: y1), CGPoint(x: mx, y: y2), CGPoint(x: x2, y: y2)]
            } else {
                let midY = y1 + (y2 > y1 ? Self.rowH / 2 : -Self.rowH / 2)
                pts = [CGPoint(x: x1, y: y1), CGPoint(x: x1 + 7, y: y1), CGPoint(x: x1 + 7, y: midY),
                       CGPoint(x: x2 - 9, y: midY), CGPoint(x: x2 - 9, y: y2), CGPoint(x: x2, y: y2)]
            }
            return ListsArrow(id: "\(d.dependsOnId)-\(d.taskId)", points: pts, violated: violated, active: active)
        }
    }

    // MARK: - dragging

    private func barGesture(_ t: TaskItem, orig: ListsSpan, m: ListsTimelineModel, resizable: Bool) -> some Gesture {
        LongPressGesture(minimumDuration: 0.25, maximumDistance: 8)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space)))
            .updating($pressing) { value, state, _ in
                if case .second(true, _) = value { state = true }
            }
            .onChanged { value in
                guard case let .second(true, d) = value else { return }
                if drag?.taskId != t.id {
                    // Picked up.
                    settling = nil
                    track = ListsDragTrack()
                    drag = ListsTimelineDrag(taskId: t.id)
                    Haptics.tap()
                }
                guard let d else { return }
                if drag?.mode == nil {
                    drag?.mode = Self.mode(at: d.startLocation.x, of: orig, in: m, resizable: resizable)
                }
                track.translation = d.translation.width
                track.scrollAtEvent = scroll.x
                updateDelta()
                updateAutoScroll(viewportX: d.location.x - scroll.x)
            }
            .onEnded { value in
                guard case .second(true, _) = value, let dr = drag, dr.taskId == t.id else { return }
                finish(dr)
            }
    }

    /// Where the finger landed decides what the drag does: the ends resize, the middle moves.
    private static func mode(at x: CGFloat, of span: ListsSpan, in m: ListsTimelineModel, resizable: Bool) -> ListsDragMode {
        guard resizable else { return .move }
        let left = m.x(span.s) + 3
        let width = CGFloat(diffDays(span.e, span.s) + 1) * dayW - 6
        let handle = min(16, width / 3)
        let rel = x - left
        if rel < handle { return .start }
        if rel > width - handle { return .end }
        return .move
    }

    /// Recompute the day offset from the finger and any auto-scroll since its last move; tick once per day.
    private func updateDelta() {
        guard var dr = drag, dr.mode != nil, let t = store.task(dr.taskId) else { return }
        let px = track.translation + (scroll.x - track.scrollAtEvent)
        let delta = Int((px / Self.dayW).rounded())
        guard delta != dr.delta else { return }
        dr.delta = delta
        drag = dr
        let next = delta == 0 ? nil : listsNextSpan(t, dr.mode!, delta)
        if next.flatMap(ListsSpan.of) != preview.flatMap({ ListsSpan.of($0.next) }) { Haptics.select() }
        if let next {
            preview = ListsTimelinePreview(taskId: t.id, next: next, p: store.previewFor(t.id, next))
        } else {
            preview = nil
        }
    }

    /// Near the left or right edge the grid scrolls by itself so a bar can travel further than one screen.
    private func updateAutoScroll(viewportX: CGFloat) {
        let zone: CGFloat = 32
        let dir: CGFloat = viewportX < zone ? -1 : viewportX > scroll.viewport - zone ? 1 : 0
        if dir == 0 {
            autoScroll?.cancel()
            autoScroll = nil
            return
        }
        guard autoScroll == nil else { return }
        autoScroll = Task { @MainActor in
            while !Task.isCancelled, drag != nil {
                let maxX = max(0, scroll.content - scroll.viewport)
                let next = min(maxX, max(0, scroll.x + dir * 5))
                if next == scroll.x { break }
                position.scrollTo(x: next)
                try? await Task.sleep(for: .milliseconds(33))
            }
        }
    }

    private func finish(_ dr: ListsTimelineDrag) {
        autoScroll?.cancel()
        autoScroll = nil
        let p = preview
        withAnimation(ObMotion.standard) {
            drag = nil
            preview = nil
        }
        guard let mode = dr.mode, dr.delta != 0, let t = store.task(dr.taskId) else { return }
        let next = listsNextSpan(t, mode, dr.delta)
        guard let span = ListsSpan.of(next), span != ListsSpan.of(t) else { return }
        store.requestDateChange(t.id, TimedSpan(startDate: next.startDate, dueDate: next.dueDate))
        if store.pendingChange == nil, p?.p.hasImpact != true {
            // Applied directly: keep the bar where it was dropped until the store has it.
            settling = (t.id, span)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.2))
                if settling?.id == t.id { settling = nil }
            }
        }
    }

    private func cancelDrag() {
        autoScroll?.cancel()
        autoScroll = nil
        withAnimation(ObMotion.standard) {
            drag = nil
            preview = nil
        }
    }

    /// What the host shows at the top while a bar is held.
    private func readout(_ m: ListsTimelineModel) -> ListsTimelineReadout? {
        guard let drag else { return nil }
        guard drag.delta != 0, let preview else {
            return ListsTimelineReadout(head: "변경 없음", dates: nil, impact: nil, tone: .neutral)
        }
        let s = preview.p.report.summary
        var parts: [String] = []
        if s.delayedCount > 0 { parts.append("\(s.delayedCount)개 밀림") }
        if s.conflictCount > 0 { parts.append("충돌 \(s.conflictCount)") }
        return ListsTimelineReadout(
            head: "\(drag.delta > 0 ? "+" : "−")\(formatDaysKo(abs(drag.delta)))",
            dates: ListsSpan.of(preview.next).map(ListsSpan.text),
            impact: parts.isEmpty ? "다른 일정 영향 없음" : parts.joined(separator: " · "),
            tone: s.conflictCount > 0 ? .danger : s.delayedCount > 0 ? .warn : .ok
        )
    }

    // MARK: - footer (날짜 없음 + legend)

    @ViewBuilder
    private func footer(_ m: ListsTimelineModel) -> some View {
        let unscheduled = tasks.filter { ListsSpan.of($0) == nil && $0.isActive }
        if !unscheduled.isEmpty {
            FlowRow(spacing: 6, lineSpacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .foregroundStyle(Ob.text3)
                    Text("날짜 없음")
                    Text("\(unscheduled.count)")
                        .foregroundStyle(Ob.text3)
                        .monospacedDigit()
                }
                .font(ObFont.caption.weight(.medium))
                .foregroundStyle(Ob.text2)
                .frame(height: 30)
                .padding(.trailing, ObSpace.xs)

                ForEach(unscheduled) { t in
                    Button {
                        router.openTask(t.id)
                    } label: {
                        Text(t.title)
                            .font(ObFont.caption)
                            .foregroundStyle(Ob.text2)
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: 220, minHeight: 30)
                            .overlay(Capsule().strokeBorder(Ob.border, lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("열어서 날짜 넣기")
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.vertical, ObSpace.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Hairline() }
        }

        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.left.and.right")
                    .foregroundStyle(Ob.text3)
                Text("길게 눌러 끌면 이동 · 양 끝을 끌어 기간 조절")
            }
            .font(ObFont.caption)
            .foregroundStyle(Ob.text2)

            FlowRow(spacing: 14, lineSpacing: 6) {
                legendItem("작업") { ListsLegendSwatch(kind: .bar) }
                legendItem("고정 일정") { ListsLegendSwatch(kind: .fixed) }
                legendItem("밀리는 작업") { ListsLegendSwatch(kind: .shift) }
                legendItem("고정 일정 충돌") { ListsLegendSwatch(kind: .conflict) }
                legendItem("오늘") { Rectangle().fill(Ob.text3).frame(width: 1, height: 12) }
            }
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.md)
        .padding(.bottom, ObSpace.xxl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Hairline() }
    }

    private func legendItem<S: View>(_ text: String, @ViewBuilder swatch: () -> S) -> some View {
        HStack(spacing: 6) {
            swatch()
            Text(text)
        }
        .font(ObFont.caption)
        .foregroundStyle(Ob.text3)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - model

/// A task's span on the grid: start (or due) … due (or start).
struct ListsSpan: Hashable {
    var s: ISODate
    var e: ISODate

    static func of(_ t: DateSpanLike) -> ListsSpan? {
        guard let a = t.startDate ?? t.dueDate, let b = t.dueDate ?? t.startDate else { return nil }
        return ListsSpan(s: a, e: b)
    }

    /// "11/16 (월)" or "11/16 – 11/18" (the drag readout).
    static func text(_ sp: ListsSpan) -> String {
        func md(_ d: ISODate) -> String {
            let p = d.split(separator: "-").map { Int($0) ?? 0 }
            return p.count == 3 ? "\(p[1])/\(p[2])" : d
        }
        return sp.s == sp.e ? formatShortKo(sp.s) : "\(md(sp.s)) – \(md(sp.e))"
    }
}

enum ListsDragMode: Equatable { case move, start, end }

/// The dates a drag produces (web Timeline.tsx `nextSpan`).
func listsNextSpan(_ t: TaskItem, _ mode: ListsDragMode, _ delta: Int) -> DateSpan {
    guard let sp = ListsSpan.of(t) else { return DateSpan(startDate: t.startDate, dueDate: t.dueDate) }
    switch mode {
    case .move:
        return DateSpan(startDate: t.startDate.map { addDays($0, delta) }, dueDate: t.dueDate.map { addDays($0, delta) })
    case .end:
        let e = addDays(sp.e, delta)
        return DateSpan(startDate: t.startDate ?? (t.dueDate != nil ? sp.s : nil), dueDate: e < sp.s ? sp.s : e)
    case .start:
        let st = addDays(sp.s, delta)
        return DateSpan(startDate: st > sp.e ? sp.e : st, dueDate: t.dueDate ?? sp.e)
    }
}

struct ListsTimelineModel {
    var today: ISODate
    var rows: [TaskItem]
    var start: ISODate
    var dates: [ISODate]

    init(tasks: [TaskItem], today: ISODate) {
        self.today = today
        rows = tasks
            .filter { ListsSpan.of($0) != nil }
            .sorted { a, b in
                let x = ListsSpan.of(a)!, y = ListsSpan.of(b)!
                if x.s != y.s { return x.s < y.s }
                if x.e != y.e { return x.e < y.e }
                return a.number < b.number
            }
        var lo = addDays(today, -4)
        var hi = addDays(today, 28)
        for t in rows {
            let sp = ListsSpan.of(t)!
            if sp.s < lo { lo = sp.s }
            if sp.e > hi { hi = sp.e }
        }
        lo = addDays(lo, -3)
        hi = addDays(hi, 14)
        let days = min(400, diffDays(hi, lo) + 1)
        start = lo
        dates = (0 ..< days).map { addDays(lo, $0) }
    }

    var width: CGFloat { CGFloat(dates.count) * ListsTimeline.dayW }

    func x(_ d: ISODate) -> CGFloat { CGFloat(diffDays(d, start)) * ListsTimeline.dayW }

    /// Today a couple of days in from the left edge.
    func homeX(viewport: CGFloat) -> CGFloat {
        let maxX = max(0, width - viewport)
        return min(maxX, max(0, x(today) - ListsTimeline.dayW * 2))
    }
}

struct ListsTimelineDrag: Equatable {
    var taskId: String
    var mode: ListsDragMode?
    var delta = 0
}

/// Not observed: written on every finger move.
final class ListsDragTrack {
    /// The finger's horizontal travel at its last move (content space).
    var translation: CGFloat = 0
    /// The scroll offset at that move: auto-scroll since then adds to the travel.
    var scrollAtEvent: CGFloat = 0
}

@Observable
final class ListsTimelineScroll {
    var x: CGFloat = 0
    var viewport: CGFloat = 0
    var content: CGFloat = 0

    func update(_ g: ListsScrollGeo) {
        if x != g.x { x = g.x }
        if viewport != g.viewport { viewport = g.viewport }
        if content != g.content { content = g.content }
    }
}

struct ListsTimelinePreview {
    var taskId: String
    var next: DateSpan
    var p: DateChangePreview
}

struct ListsScrollGeo: Equatable {
    var x: CGFloat = 0
    var viewport: CGFloat = 0
    var content: CGFloat = 0
}

struct ListsArrow: Identifiable {
    var id: String
    var points: [CGPoint]
    var violated: Bool
    var active: Bool
}

// MARK: - pieces

/// The weekday strip, moved with the grid's horizontal scroll (the only view that follows every frame).
private struct ListsTimelineHeaderStrip: View {
    var scroll: ListsTimelineScroll
    var dates: [ISODate]
    var today: ISODate

    var body: some View {
        Color.clear
            .overlay(alignment: .topLeading) {
                ListsTimelineDays(dates: dates, today: today)
                    .equatable()
                    .offset(x: -scroll.x)
            }
    }
}

/// The weekday header strip (month on the 1st, 오늘 on today, weekends tinted).
private struct ListsTimelineDays: View, Equatable {
    var dates: [ISODate]
    var today: ISODate

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(dates.enumerated()), id: \.element) { i, d in
                cell(i, d)
            }
        }
        .frame(width: CGFloat(dates.count) * ListsTimeline.dayW, height: ListsTimeline.headH, alignment: .leading)
    }

    private func cell(_ i: Int, _ d: ISODate) -> some View {
        let wd = weekday(d)
        let weekend = wd == 0 || wd == 6
        let isToday = d == today
        let first = d.hasSuffix("-01") || i == 0
        let monthStart = d.hasSuffix("-01") && i > 0
        let parts = d.split(separator: "-").map { Int($0) ?? 0 }
        return VStack(spacing: 3) {
            Spacer(minLength: 0)
            Group {
                if first {
                    Text("\(parts[1])월").fontWeight(.semibold).foregroundStyle(Ob.text)
                } else if isToday {
                    Text("오늘").fontWeight(.semibold).foregroundStyle(Ob.text)
                } else {
                    Text(WEEKDAYS_KO[wd]).foregroundStyle(Ob.text3)
                }
            }
            .font(.system(size: 10))
            .lineLimit(1)
            .fixedSize()
            Text("\(parts[2])")
                .font(.system(size: 12, weight: isToday ? .semibold : .medium).monospacedDigit())
                .foregroundStyle(isToday ? Ob.onPrimary : weekend ? Ob.text3 : Ob.text2)
                .frame(width: 24, height: 22)
                .background { if isToday { Capsule().fill(Ob.primary) } }
        }
        .padding(.bottom, 6)
        .frame(width: ListsTimeline.dayW, height: ListsTimeline.headH)
        .background(weekend ? Ob.tint : .clear)
        .overlay(alignment: .leading) {
            if monthStart {
                Rectangle().fill(Ob.borderStrong).frame(width: 1)
            } else if wd == 1 {
                Rectangle().fill(Ob.border).frame(width: 1)
            }
        }
        .overlay(alignment: .bottom) {
            if isToday { Rectangle().fill(Ob.text3).frame(width: 1, height: 5) }
        }
    }
}

/// Day columns behind the bars: faint day lines, weekend tint, week and month lines, today's column.
private struct ListsTimelineColumns: View, Equatable {
    var dates: [ISODate]
    var today: ISODate
    var height: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(dates.enumerated()), id: \.element) { i, d in
                let wd = weekday(d)
                let monthStart = i > 0 && d.hasSuffix("-01")
                Rectangle()
                    .fill(d == today || wd == 0 || wd == 6 ? Ob.tint : Color.clear)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(monthStart ? Ob.borderStrong : wd == 1 ? Ob.border : Ob.border.opacity(0.45))
                            .frame(width: 1)
                    }
                    .frame(width: ListsTimeline.dayW, height: height)
            }
        }
        .allowsHitTesting(false)
    }
}

/// One bar: project tint (identity), hatch when fixed, tone outline for overdue / pushed / conflict.
private struct ListsTimelineBar: View {
    var title: String
    var ink: Color
    var width: CGFloat
    var height: CGFloat
    var fixed: Bool
    var done: Bool
    var overdue: Bool
    var kind: ImpactKind?
    var lifted: Bool
    var handles: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: ObRadius.sm)
        shape
            .fill(fill)
            .overlay {
                if fixed && kind != .shifted && kind != .conflict {
                    ListsHatch().stroke(ink.opacity(0.22), lineWidth: 1).clipShape(shape)
                }
            }
            .overlay { shape.strokeBorder(stroke.color, lineWidth: stroke.width) }
            .overlay(alignment: .leading) {
                HStack(spacing: 4) {
                    if fixed {
                        Image(systemName: "pin")
                            .font(.system(size: 9))
                            .foregroundStyle(Ob.text2)
                    }
                    if width >= 44 {
                        Text(title)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, width >= 44 ? 9 : 6)
            }
            .overlay {
                // Grips only where they don't crowd the bar (2+ days), or while it is held.
                if handles, width >= 66 || lifted {
                    HStack {
                        grip
                        Spacer(minLength: 0)
                        grip
                    }
                    .padding(.horizontal, 2.5)
                }
            }
            .frame(width: max(width, 8), height: height)
            .opacity(done ? 0.45 : 1)
            .shadow(color: .black.opacity(lifted ? 0.18 : 0), radius: lifted ? 10 : 0, y: lifted ? 4 : 0)
            .animation(ObMotion.fast, value: lifted)
    }

    private var grip: some View {
        Capsule()
            .fill(ink.opacity(lifted ? 0.8 : 0.5))
            .frame(width: 2, height: 12)
    }

    private var fill: Color {
        switch kind {
        case .shifted: return Ob.warn.opacity(0.14)
        case .conflict: return Ob.danger.opacity(0.12)
        default: return ink.opacity(fixed ? 0.12 : 0.16)
        }
    }

    private var stroke: (color: Color, width: CGFloat) {
        if lifted { return (ink, 1.5) }
        switch kind {
        case .shifted: return (Ob.warn, 1.5)
        case .conflict: return (Ob.danger, 1.5)
        case .absorbed: return (Ob.ok, 1.5)
        default: break
        }
        if overdue { return (Ob.danger, 1.5) }
        return (ink.opacity(0.36), 1)
    }
}

/// Fine diagonal hatch: "this date doesn't move".
private struct ListsHatch: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX {
            p.move(to: CGPoint(x: x, y: rect.maxY))
            p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            x += 6
        }
        return p
    }
}

private struct ListsArrowShape: Shape {
    var points: [CGPoint]
    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard let first = points.first else { return p }
        p.move(to: first)
        for pt in points.dropFirst() { p.addLine(to: pt) }
        return p
    }
}

private struct ListsArrowHead: Shape {
    var tip: CGPoint
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: tip.x - 6, y: tip.y - 3.5))
        p.addLine(to: tip)
        p.addLine(to: CGPoint(x: tip.x - 6, y: tip.y + 3.5))
        p.closeSubpath()
        return p
    }
}

private struct ListsLegendSwatch: View {
    enum Kind { case bar, fixed, shift, conflict }
    var kind: Kind

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 3)
        Group {
            switch kind {
            case .bar:
                shape.fill(Ob.text3.opacity(0.16)).overlay(shape.strokeBorder(Ob.text3.opacity(0.4), lineWidth: 1))
            case .fixed:
                shape.fill(Ob.text3.opacity(0.1))
                    .overlay(ListsHatch().stroke(Ob.text3.opacity(0.4), lineWidth: 1).clipShape(shape))
                    .overlay(shape.strokeBorder(Ob.text3.opacity(0.4), lineWidth: 1))
            case .shift:
                shape.fill(Ob.warn.opacity(0.14)).overlay(shape.strokeBorder(Ob.warn, lineWidth: 1))
            case .conflict:
                shape.fill(Ob.danger.opacity(0.12)).overlay(shape.strokeBorder(Ob.danger, lineWidth: 1.5))
            }
        }
        .frame(width: 16, height: 10)
    }
}

private struct ListsTimelinePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Ob.surface2 : .clear)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

// MARK: - host (drag readout + scroll lock)

struct ListsTimelineReadout: Equatable {
    var head: String
    var dates: String?
    var impact: String?
    var tone: Tone
}

struct ListsTimelineReadoutKey: PreferenceKey {
    static let defaultValue: ListsTimelineReadout? = nil
    static func reduce(value: inout ListsTimelineReadout?, nextValue: () -> ListsTimelineReadout?) {
        value = value ?? nextValue()
    }
}

extension View {
    /// For the ScrollView that holds a `ListsTimeline`: locks its scrolling while a bar is held and shows
    /// the live readout ("+2일 · 11/16 – 11/18 · 3개 밀림") floating at the top.
    func listsTimelineHost() -> some View {
        modifier(ListsTimelineHost())
    }
}

private struct ListsTimelineHost: ViewModifier {
    @State private var readout: ListsTimelineReadout?

    func body(content: Content) -> some View {
        content
            .scrollDisabled(readout != nil)
            .onPreferenceChange(ListsTimelineReadoutKey.self) { value in
                readout = value
            }
            .overlay(alignment: .top) {
                if let readout {
                    ListsTimelineHUD(readout: readout)
                        .padding(.top, ObSpace.sm)
                        .transition(.opacity)
                }
            }
            .animation(ObMotion.fast, value: readout == nil)
    }
}

private struct ListsTimelineHUD: View {
    var readout: ListsTimelineReadout

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            Text(readout.head)
                .font(ObFont.sub.weight(.semibold).monospacedDigit())
                .foregroundStyle(Ob.text)
            if let dates = readout.dates {
                Text(dates)
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
            if let impact = readout.impact {
                Text(impact)
                    .font(ObFont.footnote.weight(.medium))
                    .foregroundStyle(readout.tone.text)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, ObSpace.lg)
        .frame(height: 40)
        .obGlass(in: Capsule())
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
