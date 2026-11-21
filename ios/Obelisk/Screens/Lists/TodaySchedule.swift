import Observation
import SwiftUI

/// 오늘 › 시간표 (web TodaySchedule): one day across every space as a vertical timeline. Timed tasks are
/// fixed boxes; time blocks are tinted bars you can move and stretch (15-minute snap, which locks them);
/// 자동으로 채우기 proposes blocks for the day's work around them (ghost bars until 이대로 저장); 계획에 없는
/// 일 lists what still has no block, and a tap places it at the next free time.
@Observable
@MainActor
final class DayPlanModel {
    var date: ISODate
    var view: DayView?
    var proposal: DayProposalResponse?
    var fillAhead = false
    var loading = false
    var proposing = false
    var error: String?

    init(date: ISODate) { self.date = date }

    var tasks: [String: OverviewTask] {
        var out: [String: OverviewTask] = [:]
        for t in view?.tasks ?? [] { out[t.id] = t }
        for t in proposal?.tasks ?? [] { out[t.id] = t }
        return out
    }

    var projects: [String: OverviewProject] {
        var out: [String: OverviewProject] = [:]
        for p in (view?.projects ?? []) + (proposal?.projects ?? []) { out[p.id] = p }
        return out
    }

    func load(_ store: AppStore, silent: Bool = false) async {
        if !silent { loading = view == nil }
        defer { loading = false }
        do {
            let v: DayView = try await API.shared.get("/api/plan/day/\(date)")
            guard v.date == date else { return }
            view = v
            if v.running != store.running { store.running = v.running }
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? "하루 계획을 불러오지 못했어요"
        }
    }

    func propose(_ store: AppStore) async {
        proposing = true
        defer { proposing = false }
        do {
            let r: DayProposalResponse = try await API.shared.send(
                .post, "/api/plan/day/\(date)/auto", json: ["fillAhead": .bool(fillAhead)]
            )
            if r.plan.blocks.contains(where: { !$0.kept }) {
                proposal = r
            } else {
                proposal = nil
                store.toasts.show(r.plan.unplaced.isEmpty ? "새로 넣을 일이 없어요" : "빈 시간이 없어 넣지 못했어요")
            }
        } catch {
            store.report(error, "계획을 짜지 못했어요")
        }
    }

    func apply(_ store: AppStore) async {
        proposing = true
        defer { proposing = false }
        do {
            let r: DayProposalResponse = try await API.shared.send(
                .post, "/api/plan/day/\(date)/auto", json: ["fillAhead": .bool(fillAhead), "apply": .bool(true)]
            )
            if let v = r.view { view = v }
            proposal = nil
            Haptics.success()
            store.toasts.show("하루 계획을 저장했어요")
        } catch {
            store.report(error, "계획을 저장하지 못했어요")
        }
    }

    /// Move or stretch a block (that locks it).
    func update(_ store: AppStore, _ block: TimeBlock, start: Int, end: Int) async {
        struct R: Codable { var block: TimeBlock }
        guard var v = view, let i = v.blocks.firstIndex(where: { $0.id == block.id }) else { return }
        let prev = v.blocks[i]
        v.blocks[i].start = fromMinutes(start)
        v.blocks[i].end = fromMinutes(end)
        v.blocks[i].locked = true
        view = v
        do {
            let _: R = try await API.shared.send(
                .patch, "/api/plan/blocks/\(block.id)", json: ["start": .string(fromMinutes(start)), "end": .string(fromMinutes(end))]
            )
            await load(store, silent: true)
        } catch {
            if var back = view, let j = back.blocks.firstIndex(where: { $0.id == block.id }) {
                back.blocks[j] = prev
                view = back
            }
            store.report(error, "블록을 옮기지 못했어요")
        }
    }

    func setLocked(_ store: AppStore, _ block: TimeBlock, _ locked: Bool) async {
        struct R: Codable { var block: TimeBlock }
        do {
            let _: R = try await API.shared.send(.patch, "/api/plan/blocks/\(block.id)", json: ["locked": .bool(locked)])
            await load(store, silent: true)
        } catch {
            store.report(error)
        }
    }

    func delete(_ store: AppStore, _ block: TimeBlock) async {
        view?.blocks.removeAll { $0.id == block.id }
        do {
            try await API.shared.send(.delete, "/api/plan/blocks/\(block.id)")
            await load(store, silent: true)
        } catch {
            store.report(error, "블록을 지우지 못했어요")
            await load(store, silent: true)
        }
    }

    func clear(_ store: AppStore, onlyPlanned: Bool) async {
        do {
            try await API.shared.send(.delete, "/api/plan/day/\(date)\(onlyPlanned ? "?unlocked=true" : "")")
            proposal = nil
            await load(store, silent: true)
        } catch {
            store.report(error)
        }
    }

    /// Put pending work at the next free time that day.
    func place(_ store: AppStore, _ p: DayPending) async {
        guard let v = view else { return }
        let busy = v.events.map { MinuteInterval(start: toMinutes($0.start), end: toMinutes($0.end)) }
            + v.blocks.map { MinuteInterval(start: toMinutes($0.start), end: toMinutes($0.end)) }
        let from = v.now.date == date ? v.now.minutes : 0
        guard let slot = nextFreeSlot(hours: v.hours, busy: busy, from: from, minutes: max(15, p.minutes)) else {
            store.toasts.error("오늘 근무 시간 안에 빈 시간이 없어요")
            return
        }
        struct R: Codable { var block: TimeBlock }
        do {
            let _: R = try await API.shared.send(.post, "/api/plan/blocks", json: [
                "taskId": .string(p.taskId), "date": .string(date),
                "start": .string(fromMinutes(slot.start)), "end": .string(fromMinutes(slot.end)),
            ])
            Haptics.tap()
            await load(store, silent: true)
        } catch {
            store.report(error, "블록을 만들지 못했어요")
        }
    }
}

struct TodaySchedule: View {
    @Binding var mode: TodayMode
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var model = DayPlanModel(date: AppStore.localToday())
    @State private var selected: String?

    @State private var scrolledFor: ISODate?

    var body: some View {
        ScrollViewReader { proxy in
            content
                .onChange(of: model.view?.date) { _, d in
                    // Today opens at the current hour; other days start at the top (their work starts there).
                    guard let d, scrolledFor != d else { return }
                    scrolledFor = d
                    guard d == store.today else {
                        withAnimation(ObMotion.mid) { proxy.scrollTo(TodayScheduleTop.id, anchor: .top) }
                        return
                    }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(120))
                        withAnimation(ObMotion.mid) { proxy.scrollTo(DayTimeline.anchor, anchor: .top) }
                    }
                }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                Color.clear.frame(height: 0).id(TodayScheduleTop.id)
                header
                if let v = model.view {
                    summary(v)
                    actions(v)
                    if let p = model.proposal { proposalBar(p) }
                    DayTimeline(model: model, selected: $selected) { id in openTask(id) }
                        .padding(.horizontal, ObSpace.page)
                    pending(v)
                } else if let e = model.error {
                    EmptyState("하루 계획을 불러오지 못했어요", message: e) {
                        Button("다시 시도") { Task { await model.load(store) } }
                            .buttonStyle(.ob(.outline, size: .small))
                    }
                } else {
                    LoadingView()
                }
            }
            .padding(.bottom, 140)
        }
        .refreshable { await model.load(store, silent: true) }
        .task(id: "\(model.date)|\(store.revision)|\(store.running?.entry.id ?? "")") {
            await model.load(store, silent: model.view != nil)
        }
        .onAppear {
            if model.view == nil { model.date = store.today }
        }
        .onChange(of: model.fillAhead) { _, _ in
            if model.proposal != nil { Task { await model.propose(store) } }
        }
    }

    // MARK: header

    private var header: some View {
        let today = store.today
        let isToday = model.date == today
        return VStack(alignment: .leading, spacing: ObSpace.md) {
            ListsHeader(
                isToday ? "오늘" : formatRelativeKo(model.date, today),
                description: longDateKo(model.date),
                actions: {
                    HStack(spacing: 4) {
                        stepButton("chevron.left", label: "전날") { step(-1) }
                        if !isToday {
                            Button("오늘") { go(today) }
                                .buttonStyle(.ob(.outline, size: .small))
                        }
                        stepButton("chevron.right", label: "다음날") { step(1) }
                        Menu {
                            Button {
                                Task { await model.clear(store, onlyPlanned: true) }
                            } label: {
                                Label("자동으로 넣은 블록 지우기", systemImage: "eraser")
                            }
                            Button(role: .destructive) {
                                Task { await model.clear(store, onlyPlanned: false) }
                            } label: {
                                Label("이 날 블록 모두 지우기", systemImage: "trash")
                            }
                            Divider()
                            Button {
                                router.openSettings(.planning)
                            } label: {
                                Label("근무 시간 설정", systemImage: "clock")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Ob.text2)
                                .frame(width: ObSize.controlSm, height: ObSize.controlSm)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("시간표 메뉴")
                    }
                }
            )
            TodayModePicker(mode: $mode)
                .padding(.horizontal, ObSpace.page)
        }
    }

    private func stepButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Ob.text2)
                .frame(width: ObSize.controlSm, height: ObSize.controlSm)
                .background(Ob.surface2, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func step(_ days: Int) { go(addDays(model.date, days)) }

    private func go(_ date: ISODate) {
        Haptics.select()
        selected = nil
        model.proposal = nil
        model.view = nil
        model.date = date
    }

    // MARK: summary + actions

    private func summary(_ v: DayView) -> some View {
        let over = v.needed - v.capacity
        return VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: 0) {
                stat("일할 수 있는 시간", v.capacity)
                Hairline(vertical: true).frame(height: 32)
                stat("계획", v.planned)
                Hairline(vertical: true).frame(height: 32)
                stat("필요", v.needed)
            }
            .padding(.vertical, ObSpace.sm)
            .obCard(padding: 0)
            if !v.workday {
                Text("쉬는 날로 정한 날이에요. 그래도 계획할 수는 있어요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
            }
            if over > 0, v.date >= v.today {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(Ob.warn)
                    Text("할 일이 \(formatDurationKo(over)) 넘쳐요. 일부는 다른 날로 미루는 게 좋아요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.warnText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .obCallout(.warn)
            }
            ForEach(v.late, id: \.taskId) { l in
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Image(systemName: "clock.badge.exclamationmark")
                        .foregroundStyle(Ob.danger)
                    Text("\(title(l.taskId)) 블록이 마감 \(formatTimeKo(l.dueTime))보다 늦게 끝나요 (\(formatTimeKo(l.end)))")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.dangerText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .obCallout(.danger)
            }
        }
        .padding(.horizontal, ObSpace.page)
    }

    private func stat(_ label: String, _ minutes: Int) -> some View {
        VStack(spacing: 2) {
            Text(minutes > 0 ? formatDurationKo(minutes) : "0분")
                .font(ObFont.bodyStrong.monospacedDigit())
                .foregroundStyle(Ob.text)
            Text(label)
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func actions(_ v: DayView) -> some View {
        if v.date >= v.today {
            VStack(alignment: .leading, spacing: ObSpace.sm) {
                HStack(spacing: ObSpace.sm) {
                    Button {
                        Task { await model.propose(store) }
                    } label: {
                        HStack(spacing: 6) {
                            if model.proposing { ProgressView().controlSize(.small) } else {
                                Image(systemName: "wand.and.rays").font(.system(size: 13, weight: .medium))
                            }
                            Text("자동으로 채우기")
                        }
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                    .disabled(model.proposing)
                    Spacer(minLength: 0)
                }
                Toggle(isOn: Binding(get: { model.fillAhead }, set: { model.fillAhead = $0 })) {
                    Text("남는 시간에 다가오는 일 채우기")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                }
            }
            .padding(.horizontal, ObSpace.page)
        }
    }

    private func proposalBar(_ p: DayProposalResponse) -> some View {
        let fresh = p.plan.blocks.filter { !$0.kept }
        let minutes = fresh.reduce(0) { $0 + toMinutes($1.end) - toMinutes($1.start) }
        return VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text("새 블록 \(fresh.count)개를 제안했어요 · 모두 \(formatDurationKo(minutes))")
                .font(ObFont.sub.weight(.medium))
                .foregroundStyle(Ob.text)
            if !p.plan.unplaced.isEmpty {
                Text("자리를 못 찾은 일 \(p.plan.unplaced.count)개: \(p.plan.unplaced.prefix(3).map { title($0.taskId) }.joined(separator: ", "))")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: ObSpace.sm) {
                Button("이대로 저장") { Task { await model.apply(store) } }
                    .buttonStyle(.ob(.primary, size: .small))
                    .disabled(model.proposing)
                Button("취소") {
                    withAnimation(ObMotion.standard) { model.proposal = nil }
                }
                .buttonStyle(.ob(.ghost, size: .small))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .obCallout(.info)
        .padding(.horizontal, ObSpace.page)
        .transition(.opacity)
    }

    // MARK: pending

    @ViewBuilder
    private func pending(_ v: DayView) -> some View {
        if !v.pending.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("계획에 없는 일")
                        .font(ObFont.footnote.weight(.semibold))
                        .foregroundStyle(Ob.text)
                    Text("\(v.pending.count)")
                        .font(ObFont.footnote.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    Spacer()
                    Text("누르면 빈 시간에 넣어요")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
                .frame(minHeight: 36)
                ForEach(v.pending, id: \.taskId) { p in
                    Button {
                        Task { await model.place(store, p) }
                    } label: {
                        HStack(spacing: ObSpace.sm) {
                            Image(systemName: "plus.circle")
                                .foregroundStyle(Ob.text3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title(p.taskId))
                                    .font(ObFont.body)
                                    .foregroundStyle(Ob.text)
                                    .lineLimit(1)
                                if let space = spaceName(p.taskId) {
                                    Text(space)
                                        .font(ObFont.caption)
                                        .foregroundStyle(Ob.text3)
                                }
                            }
                            Spacer(minLength: ObSpace.sm)
                            if let r = p.reason {
                                Chip(text: r.labelKo, tone: r == .blocked ? .neutral : .warn, filled: true)
                            }
                            Text(formatDurationKo(p.minutes))
                                .font(ObFont.sub.monospacedDigit())
                                .foregroundStyle(Ob.text2)
                        }
                        .frame(minHeight: ObSize.row)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(v.date < v.today)
                    .contextMenu {
                        Button {
                            openTask(p.taskId)
                        } label: {
                            Label("작업 열기", systemImage: "arrow.up.right")
                        }
                    }
                    Hairline()
                }
            }
            .padding(.horizontal, ObSpace.page)
        }
    }

    // MARK: helpers

    private func title(_ id: String) -> String {
        model.tasks[id].map { "#\($0.number) \($0.task.title)" } ?? "볼 수 없는 작업"
    }

    private func spaceName(_ taskId: String) -> String? {
        guard let t = model.tasks[taskId], t.task.workspaceId != store.workspace?.id else { return nil }
        guard let w = store.workspaces.first(where: { $0.id == t.task.workspaceId }) else { return nil }
        return w.kind == .personal ? "개인 공간" : w.name
    }

    private func openTask(_ id: String) {
        guard let t = model.tasks[id] else { return }
        if t.task.workspaceId != store.workspace?.id {
            Task {
                await store.switchWorkspace(t.task.workspaceId)
                router.openTask(id)
            }
        } else {
            router.openTask(id)
        }
    }
}

enum TodayScheduleTop { static let id = "schedule-top" }

/// 목록 · 시간표
enum TodayMode: String, CaseIterable, Identifiable {
    case list, schedule
    var id: String { rawValue }
    var label: String { self == .list ? "목록" : "시간표" }
}

struct TodayModePicker: View {
    @Binding var mode: TodayMode

    var body: some View {
        Picker("오늘 보기", selection: Binding(
            get: { mode },
            set: { m in
                Haptics.select()
                withAnimation(ObMotion.mid) { mode = m }
            }
        )) {
            ForEach(TodayMode.allCases) { m in Text(m.label).tag(m) }
        }
        .pickerStyle(.segmented)
        .fixedSize()
    }
}

// MARK: - the timeline

/// Hours down the side, timed tasks as boxes, blocks as tinted bars, the proposal as dashed ghosts.
struct DayTimeline: View {
    var model: DayPlanModel
    @Binding var selected: String?
    var open: (String) -> Void

    @Environment(AppStore.self) private var store
    /// Live drag of the selected block: minutes moved (start) and stretched (end).
    @State private var moveBy = 0
    @State private var stretchBy = 0

    private static let hourHeight: CGFloat = 64
    private static let gutter: CGFloat = 60
    private var ppm: CGFloat { Self.hourHeight / 60 }

    var body: some View {
        if let v = model.view {
            let range = hourRange(v)
            let height = CGFloat(range.upperBound - range.lowerBound) * Self.hourHeight
            GeometryReader { geo in
                let width = geo.size.width - Self.gutter
                ZStack(alignment: .topLeading) {
                    // Where the screen opens: an hour before now today, the start of work on other days.
                    VStack(spacing: 0) {
                        Color.clear.frame(height: max(0, y(focusMinute(v), range)))
                        Color.clear.frame(height: 1).id(DayTimeline.anchor)
                    }
                    grid(v, range: range, width: width)
                    let lane = lanes(v)
                    ForEach(v.events, id: \.taskId) { e in
                        let l = lane["e:" + e.taskId] ?? (0, 1)
                        eventBox(e, range: range, width: (width - 4) / CGFloat(l.1), x: (width - 4) / CGFloat(l.1) * CGFloat(l.0))
                    }
                    if let p = model.proposal {
                        ForEach(Array(p.plan.blocks.filter { !$0.kept }.enumerated()), id: \.offset) { _, b in
                            ghost(b, range: range, width: width)
                        }
                    }
                    ForEach(v.blocks) { b in
                        let l = selected == b.id ? (0, 1) : (lane["b:" + b.id] ?? (0, 1))
                        blockBar(b, range: range, width: (width - 4) / CGFloat(l.1), x: (width - 4) / CGFloat(l.1) * CGFloat(l.0))
                    }
                    if v.now.date == v.date {
                        nowLine(v.now.minutes, range: range, width: width)
                    }
                }
            }
            .frame(height: height)
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(ObMotion.fast) { selected = nil } }
        }
    }

    static let anchor = "timeline-focus"

    private func focusMinute(_ v: DayView) -> Int {
        let first = v.blocks.map { toMinutes($0.start) }.min()
        if v.now.date == v.date { return max(0, v.now.minutes - 60) }
        return max(0, min(first ?? Int.max, toMinutes(v.hours.start)) - 30)
    }

    private func hourRange(_ v: DayView) -> ClosedRange<Int> {
        var lo = max(0, toMinutes(v.hours.start) / 60 - 1)
        var hi = min(24, Int((Double(toMinutes(v.hours.end)) / 60).rounded(.up)) + 1)
        let spans = v.events.map { ($0.start, $0.end) } + v.blocks.map { ($0.start, $0.end) }
            + (model.proposal?.plan.blocks.map { ($0.start, $0.end) } ?? [])
        for (s, e) in spans {
            lo = min(lo, toMinutes(s) / 60)
            hi = max(hi, Int((Double(toMinutes(e)) / 60).rounded(.up)))
        }
        return lo ... max(lo + 1, min(24, hi))
    }

    /// Side-by-side columns for things that overlap (events and blocks together): id → (lane, lanes).
    private func lanes(_ v: DayView) -> [String: (Int, Int)] {
        let items = (v.events.map { ("e:" + $0.taskId, toMinutes($0.start), toMinutes($0.end)) }
            + v.blocks.map { ("b:" + $0.id, toMinutes($0.start), toMinutes($0.end)) })
            .sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2 > $1.2 }
        var out: [String: (Int, Int)] = [:]
        var cluster: [(String, Int)] = []
        var laneEnds: [Int] = []
        var clusterEnd = -1
        func flush() {
            for (id, lane) in cluster { out[id] = (lane, max(1, laneEnds.count)) }
            cluster = []
            laneEnds = []
        }
        for (id, s, e) in items {
            if s >= clusterEnd { flush() }
            let lane = laneEnds.firstIndex(where: { $0 <= s }) ?? laneEnds.count
            if lane == laneEnds.count { laneEnds.append(e) } else { laneEnds[lane] = e }
            cluster.append((id, lane))
            clusterEnd = max(clusterEnd, e)
        }
        flush()
        return out
    }

    private func y(_ minutes: Int, _ range: ClosedRange<Int>) -> CGFloat {
        CGFloat(minutes - range.lowerBound * 60) * ppm
    }

    // MARK: grid

    private func grid(_ v: DayView, range: ClosedRange<Int>, width: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            // Outside working hours and breaks: a faint tint.
            let off = subtractIntervals([MinuteInterval(start: range.lowerBound * 60, end: range.upperBound * 60)], v.hours.intervals)
            ForEach(off, id: \.self) { iv in
                Rectangle()
                    .fill(Ob.tint)
                    .frame(width: width, height: CGFloat(iv.end - iv.start) * ppm)
                    .offset(x: Self.gutter, y: y(iv.start, range))
            }
            ForEach(Array(range), id: \.self) { h in
                HStack(alignment: .top, spacing: 0) {
                    Text(hourLabel(h))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(Ob.text3)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(width: Self.gutter - 8, alignment: .trailing)
                        .padding(.trailing, 8)
                        .offset(y: -7)
                    Hairline()
                        .frame(width: width)
                }
                .offset(y: CGFloat(h - range.lowerBound) * Self.hourHeight)
            }
        }
        .accessibilityHidden(true)
    }

    private func hourLabel(_ h: Int) -> String {
        if h == 0 || h == 24 { return "자정" }
        if h == 12 { return "정오" }
        return h < 12 ? "오전 \(h)시" : "오후 \(h - 12)시"
    }

    private func nowLine(_ minutes: Int, range: ClosedRange<Int>, width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Circle().fill(Ob.danger).frame(width: 7, height: 7)
            Rectangle().fill(Ob.danger).frame(width: width - 4, height: 1)
        }
        .offset(x: Self.gutter - 3.5, y: y(minutes, range) - 3.5)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: pieces

    private func eventBox(_ e: DayEvent, range: ClosedRange<Int>, width: CGFloat, x: CGFloat) -> some View {
        let s = toMinutes(e.start)
        let h = max(22, CGFloat(toMinutes(e.end) - s) * ppm)
        let t = model.tasks[e.taskId]
        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                if e.fixed { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Ob.text3) }
                Text(t?.task.title ?? "일정")
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
            }
            if h > 34 {
                Text(formatTimeRangeKo(e.start, e.end))
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(width: max(24, width - 2), height: h, alignment: .topLeading)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.sm))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.sm).strokeBorder(Ob.borderStrong, lineWidth: 1))
        .offset(x: Self.gutter + 2 + x, y: y(s, range))
        .onTapGesture { open(e.taskId) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(t?.task.title ?? "일정"), \(formatTimeRangeKo(e.start, e.end))\(e.fixed ? ", 고정 일정" : "")")
    }

    private func ghost(_ b: ProposedBlock, range: ClosedRange<Int>, width: CGFloat) -> some View {
        let s = toMinutes(b.start)
        let h = max(18, CGFloat(toMinutes(b.end) - s) * ppm)
        let t = model.tasks[b.taskId]
        return VStack(alignment: .leading, spacing: 1) {
            Text(t?.task.title ?? "작업")
                .font(ObFont.footnote.weight(.medium))
                .foregroundStyle(Ob.text2)
                .lineLimit(1)
            if h > 34 {
                Text("새로 · \(formatTimeRangeKo(b.start, b.end))")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .frame(width: width - 4, height: h, alignment: .topLeading)
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: ObRadius.sm)
                .strokeBorder(Ob.text3, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .offset(x: Self.gutter + 2, y: y(s, range))
        .allowsHitTesting(false)
        .accessibilityLabel("제안: \(t?.task.title ?? "작업"), \(formatTimeRangeKo(b.start, b.end))")
    }

    private func blockBar(_ b: TimeBlock, range: ClosedRange<Int>, width: CGFloat, x: CGFloat) -> some View {
        let isSel = selected == b.id
        let s0 = toMinutes(b.start)
        let e0 = toMinutes(b.end)
        let s = isSel ? s0 + moveBy : s0
        let e = isSel ? e0 + moveBy + stretchBy : e0
        let h = max(18, CGFloat(e - s) * ppm)
        let t = model.tasks[b.taskId]
        let project = t?.task.projectId.flatMap { model.projects[$0] }
        let palette = project?.color.palette
        let done = t.map { !$0.task.isActive } ?? false
        let editable = model.view.map { $0.date >= $0.today } ?? false

        return ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if b.locked { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(Ob.text2) }
                    Text(t?.task.title ?? "볼 수 없는 작업")
                        .font(ObFont.footnote.weight(.semibold))
                        .foregroundStyle(done ? Ob.text3 : Ob.text)
                        .strikethrough(done, color: Ob.text4)
                        .lineLimit(1)
                }
                if h > 34 {
                    Text(blockMeta(b, t: t, start: s, end: e))
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text2)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(width: max(24, width - 2), height: h, alignment: .topLeading)
            // Opaque: a block dragged over another must not show the one underneath through it.
            .background {
                RoundedRectangle(cornerRadius: ObRadius.sm).fill(Ob.bg)
                RoundedRectangle(cornerRadius: ObRadius.sm).fill(palette?.bg ?? Ob.surface2)
            }
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.sm)
                    .strokeBorder(isSel ? Ob.text : (palette?.ink.opacity(0.35) ?? Ob.border), lineWidth: isSel ? 1.5 : 1)
            )
            if isSel, editable {
                // Stretch grip.
                Capsule()
                    .fill(Ob.text)
                    .frame(width: 28, height: 4)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 20)
                    .contentShape(Rectangle())
                    .offset(y: 10)
                    .highPriorityGesture(
                        DragGesture(minimumDistance: 1)
                            .onChanged { g in
                                let d = snap(g.translation.height / ppm)
                                stretchBy = max(15 - (e0 - s0), min(d, 24 * 60 - 1 - e0 - moveBy))
                            }
                            .onEnded { _ in commit(b) }
                    )
                    .accessibilityLabel("길이 조절")
            }
        }
        .offset(x: Self.gutter + 2 + x, y: y(s, range))
        .zIndex(isSel ? 2 : 1)
        .onTapGesture {
            Haptics.select()
            withAnimation(ObMotion.fast) { selected = isSel ? nil : b.id }
        }
        .gesture(
            DragGesture(minimumDistance: 2)
                .onChanged { g in
                    guard isSel, editable else { return }
                    let d = snap(g.translation.height / ppm)
                    moveBy = max(-s0, min(d, 24 * 60 - 1 - e0))
                }
                .onEnded { _ in if isSel, editable { commit(b) } },
            including: isSel && editable ? .all : .subviews
        )
        .contextMenu {
            Button {
                open(b.taskId)
            } label: {
                Label("작업 열기", systemImage: "arrow.up.right")
            }
            if editable {
                Button {
                    Task { await model.setLocked(store, b, !b.locked) }
                } label: {
                    Label(b.locked ? "고정 해제" : "고정", systemImage: b.locked ? "pin.slash" : "pin")
                }
                Button(role: .destructive) {
                    Task { await model.delete(store, b) }
                } label: {
                    Label("삭제", systemImage: "trash")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(t?.task.title ?? "블록"), \(formatTimeRangeKo(fromMinutes(s), fromMinutes(e)))\(b.locked ? ", 고정됨" : "")")
        .accessibilityHint(isSel ? "끌어서 옮기기" : "두 번 눌러 선택")
    }

    private func blockMeta(_ b: TimeBlock, t: OverviewTask?, start: Int, end: Int) -> String {
        var parts = [formatTimeRangeKo(fromMinutes(start), fromMinutes(end))]
        if let t { parts.insert("#\(t.number)", at: 0) }
        if let t, t.task.workspaceId != store.workspace?.id,
           let w = store.workspaces.first(where: { $0.id == t.task.workspaceId }) {
            parts.append(w.kind == .personal ? "개인 공간" : w.name)
        }
        return parts.joined(separator: " · ")
    }

    private func snap(_ minutes: CGFloat) -> Int { Int((minutes / 15).rounded()) * 15 }

    private func commit(_ b: TimeBlock) {
        let s = toMinutes(b.start) + moveBy
        let e = toMinutes(b.end) + moveBy + stretchBy
        moveBy = 0
        stretchBy = 0
        guard s != toMinutes(b.start) || e != toMinutes(b.end), s >= 0, e > s, e < 24 * 60 else { return }
        Haptics.tap()
        Task { await model.update(store, b, start: s, end: e) }
    }
}
