import SwiftUI

/// 홈: a dashboard of widgets on pure black/white (web app/(app)/page.tsx, narrow-screen layout).
/// 지금 상황 · Jev · summary tiles · 지연 파급 · 주의할 작업 · 다른 공간 · 급한 업무 · 다가오는 일정 · 진행 상황,
/// in the user's own order with their own hidden set (saved on the account, apart from the wide-screen
/// layout). 홈 편집 reorders, hides and brings widgets back.
struct HomeScreen: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cache = HomeDataCache()
    /// Non-nil while editing: the arrangement being edited.
    @State private var draft: HomeLayout?
    @State private var saving = false
    @State private var appeared = false
    /// The user's wall clock, ticked on the minute (overdue-by-time, greeting, board order).
    @State private var now = clockNow()

    private var saved: HomeLayout { homeNormalize(store.user?.homeLayout, HomeWidgets.all) }

    var body: some View {
        let now = self.now
        let data = cache.data(store, now)
        Group {
            if let draft {
                editor(draft, data: data, now: now)
                    .transition(.opacity)
            } else {
                dashboard(data: data, now: now)
                    .transition(.opacity)
            }
        }
        .animation(ObMotion.mid, value: draft == nil)
        .task(id: store.timezone) {
            self.now = clockNow(store.timezone)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(nextMinuteDelay()))
                if Task.isCancelled { break }
                self.now = clockNow(store.timezone)
            }
        }
    }

    // MARK: header

    private func header(_ data: HomeData, now: Clock) -> some View {
        let hour = now.minutes / 60
        let greeting = hour < 12 ? "좋은 아침이에요" : hour < 18 ? "좋은 오후예요" : "좋은 저녁이에요"
        let name = data.userName.map { ", \($0)님" } ?? ""
        // PageHeader's look, with the subtitle under the whole row so the edit buttons don't squeeze it.
        return VStack(alignment: .leading, spacing: ObSpace.xs) {
            HStack(alignment: .center, spacing: ObSpace.md) {
                Text("홈")
                    .font(ObFont.title)
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if draft != nil {
                    HStack(spacing: ObSpace.xs) {
                        Button("취소") { cancelEdit() }
                            .buttonStyle(.ob(.ghost, size: .small))
                        Button("완료") { finishEdit() }
                            .buttonStyle(.ob(.primary, size: .small))
                    }
                } else {
                    Button {
                        startEdit()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "rectangle.3.group").font(.system(size: 13, weight: .medium))
                            Text("홈 편집")
                        }
                        .foregroundStyle(Ob.text2)
                    }
                    .buttonStyle(.ob(.ghost, size: .small))
                    .padding(.trailing, -ObSpace.sm)
                    .disabled(store.user == nil || saving)
                }
            }
            Text("\(longDateKo(data.today)) · \(greeting)\(name)")
                .font(ObFont.sub)
                .foregroundStyle(Ob.text3)
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.sm)
        .padding(.bottom, ObSpace.md)
    }

    // MARK: dashboard

    private func dashboard(data: HomeData, now: Clock) -> some View {
        let layout = saved
        let order = layout.mobile.order.filter { HomeWidgets.byId[$0] != nil }
        let rows = homeMobileRows(order, HomeWidgets.byId)

        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(data, now: now)
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    ForEach(Array(rows.enumerated()), id: \.element) { i, row in
                        Group {
                            if row.count == 2 {
                                HStack(alignment: .top, spacing: ObSpace.md) {
                                    widget(row[0], data: data, now: now)
                                    widget(row[1], data: data, now: now)
                                }
                                .fixedSize(horizontal: false, vertical: true)
                            } else if let def = HomeWidgets.byId[row[0]] {
                                frame(def, first: i == 0) {
                                    widget(def.id, data: data, now: now)
                                }
                            }
                        }
                        .id(row[0])
                    }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.top, ObSpace.xs)
                .padding(.bottom, ObSpace.xxxl)
                .opacity(appeared || reduceMotion ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 8)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await store.refresh()
            await OverviewFeed.shared.load(store)
        }
        .onAppear {
            guard !appeared else { return }
            withAnimation(ObMotion.enter) { appeared = true }
        }
    }

    /// Section widgets get a page-section heading (and lead) above their body; cards stand alone.
    @ViewBuilder
    private func frame<Content: View>(_ def: HomeWidgetDef, first: Bool, @ViewBuilder content: () -> Content) -> some View {
        if def.chrome == .section {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                VStack(alignment: .leading, spacing: ObSpace.xs) {
                    Text(def.name)
                        .font(ObFont.title3)
                        .foregroundStyle(Ob.text)
                        .accessibilityAddTraits(.isHeader)
                    if let lead = def.lead {
                        Text(lead)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                content()
            }
            .padding(.top, first ? 0 : ObSpace.xl)
        } else {
            content()
        }
    }

    @ViewBuilder
    private func widget(_ id: String, data: HomeData, now: Clock) -> some View {
        switch id {
        case "status":
            HomeStatusCallout(data: data)
        case "jev":
            JevStrip(todayCount: data.remaining) { hideEverywhere("jev") }
        case "tile-today", "tile-overdue", "tile-delayed", "tile-conflicts", "tile-finish":
            HomeSummaryTile(data: data, kind: id)
        case "ripple":
            HomeRippleBoard(data: data)
        case "watch":
            HomeWatchList(data: data)
        case "spaces":
            HomeOtherSpaces()
        case "urgent":
            HomeUrgentBoard(today: data.today, doneToday: data.doneToday, now: now)
        case "upcoming":
            HomeUpcomingList(data: data)
        case "projects":
            HomeProjectsBoard(data: data)
        default:
            EmptyView()
        }
    }

    // MARK: editing

    private func editor(_ layout: HomeLayout, data: HomeData, now: Clock) -> some View {
        let order = layout.mobile.order.filter { HomeWidgets.byId[$0] != nil }
        let hiddenDefs = HomeWidgets.all.filter { layout.mobile.hidden.contains($0.id) }

        return List {
            Section {
                header(data, now: now)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Ob.bg)
                editBar(hiddenDefs)
                    .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: ObSpace.md, trailing: ObSpace.page))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Ob.bg)
            }
            Section {
                ForEach(order, id: \.self) { id in
                    if let def = HomeWidgets.byId[id] {
                        editRow(def, index: order.firstIndex(of: id) ?? 0, count: order.count)
                    }
                }
                .onMove { from, to in
                    var next = order
                    next.move(fromOffsets: from, toOffset: to)
                    setOrder(next)
                    Haptics.select()
                }
            } header: {
                SectionLabel("홈 위젯 순서", count: order.count)
                    .textCase(nil)
                    .padding(.horizontal, ObSpace.page)
                    .listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ob.bg)
        .environment(\.editMode, .constant(.active))
        .environment(\.defaultMinListRowHeight, 52)
    }

    private func editBar(_ hiddenDefs: [HomeWidgetDef]) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "rectangle.3.group")
                    .font(.system(size: 15))
                    .foregroundStyle(Ob.text3)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                Text("\(Text("좁은 화면 배치").fontWeight(.semibold).foregroundStyle(Ob.text)) · 손잡이를 끌어 순서를 바꿔요. 넓은 화면 배치와 따로 저장돼요.")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: ObSpace.sm) {
                Menu {
                    if hiddenDefs.isEmpty {
                        Text("숨긴 위젯이 없어요. 위젯의 눈 모양 버튼으로 숨길 수 있어요.")
                    } else {
                        ForEach(hiddenDefs) { def in
                            Button {
                                addBack(def.id)
                            } label: {
                                Label(def.name, systemImage: def.symbol)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                        Text("위젯 추가")
                        if !hiddenDefs.isEmpty {
                            Text("\(hiddenDefs.count)")
                                .font(ObFont.micro.weight(.semibold).monospacedDigit())
                                .foregroundStyle(Ob.bg)
                                .padding(.horizontal, 6)
                                .frame(minWidth: 18, minHeight: 18)
                                .background(Ob.text, in: Capsule())
                        }
                    }
                }
                .buttonStyle(.ob(.outline, size: .small))
                .menuOrder(.fixed)
                .accessibilityLabel(hiddenDefs.isEmpty ? "위젯 추가" : "위젯 추가, 숨긴 위젯 \(hiddenDefs.count)개")

                Button {
                    resetMode()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.uturn.backward").font(.system(size: 12, weight: .semibold))
                        Text("기본 배치로")
                    }
                }
                .buttonStyle(.ob(.ghost, size: .small))
                .accessibilityHint("지금 편집 중인 화면의 배치를 처음 상태로")
                Spacer(minLength: 0)
            }
        }
        .padding(ObSpace.md)
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.lg))
    }

    private func editRow(_ def: HomeWidgetDef, index: Int, count: Int) -> some View {
        HStack(spacing: ObSpace.sm) {
            Image(systemName: def.symbol)
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(def.name)
                .font(ObFont.body.weight(.medium))
                .foregroundStyle(Ob.text)
                .lineLimit(1)
            if def.mobileHalf {
                Text("반 칸")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .padding(.horizontal, 6)
                    .frame(height: 20)
                    .background(Ob.surface2, in: RoundedRectangle(cornerRadius: ObRadius.xs))
            }
            Spacer(minLength: ObSpace.sm)
            Button {
                hide(def.id)
            } label: {
                Image(systemName: "eye.slash")
                    .font(.system(size: 14))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("\(def.name) 숨기기")
        }
        .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.sm))
        .listRowBackground(Ob.bg)
        .listRowSeparatorTint(Ob.border)
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if index > 0 { Button("\(def.name) 위로") { move(def.id, by: -1) } }
            if index < count - 1 { Button("\(def.name) 아래로") { move(def.id, by: 1) } }
            Button("\(def.name) 숨기기") { hide(def.id) }
        }
    }

    private func startEdit() {
        Haptics.select()
        withAnimation(ObMotion.mid) { draft = saved }
    }

    private func cancelEdit() {
        withAnimation(ObMotion.mid) { draft = nil }
    }

    private func finishEdit() {
        let next = draft
        withAnimation(ObMotion.mid) { draft = nil }
        if let next, !homeSameLayout(next, saved) {
            Task { await persist(next, done: "홈 배치를 저장했어요") }
        }
    }

    private func setOrder(_ next: [String]) {
        guard var d = draft else { return }
        d.mobile.order = next
        withAnimation(ObMotion.mid) { draft = d }
    }

    private func move(_ id: String, by: Int) {
        guard let d = draft else { return }
        var order = d.mobile.order.filter { HomeWidgets.byId[$0] != nil }
        guard let i = order.firstIndex(of: id) else { return }
        let j = max(0, min(order.count - 1, i + by))
        guard i != j else { return }
        order.remove(at: i)
        order.insert(id, at: j)
        setOrder(order)
        UIAccessibility.post(notification: .announcement, argument: "\(HomeWidgets.byId[id]?.name ?? ""): \(j + 1)번째")
    }

    private func hide(_ id: String) {
        guard var d = draft else { return }
        d.mobile.order.removeAll { $0 == id }
        if !d.mobile.hidden.contains(id) { d.mobile.hidden.append(id) }
        withAnimation(ObMotion.mid) { draft = d }
        UIAccessibility.post(notification: .announcement, argument: "\(HomeWidgets.byId[id]?.name ?? "위젯")을 숨겼어요")
    }

    private func addBack(_ id: String) {
        guard var d = draft else { return }
        d.mobile.order.append(id)
        d.mobile.hidden.removeAll { $0 == id }
        withAnimation(ObMotion.mid) { draft = d }
    }

    private func resetMode() {
        guard var d = draft else { return }
        d.mobile = HomeWidgets.defaultLayout.mobile
        withAnimation(ObMotion.mid) { draft = d }
    }

    /// The strip's ✕ (web hideEverywhere): hide the widget on every layout and save right away.
    private func hideEverywhere(_ id: String) {
        let s = saved
        let next = HomeLayout(
            v: 1,
            desktop: .init(items: homeSettle(s.desktop.items.filter { $0.id != id }), hidden: s.desktop.hidden + [id]),
            mobile: .init(order: s.mobile.order.filter { $0 != id }, hidden: s.mobile.hidden + [id])
        )
        Task { await persist(next, done: nil) }
        store.toasts.show("Jev 추천을 홈에서 숨겼어요. 홈 편집 → 위젯 추가에서 다시 켤 수 있어요.")
    }

    // MARK: saving

    private struct MePatch: Encodable {
        var homeLayout: HomeLayout?
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            if let homeLayout { try c.encode(homeLayout, forKey: .homeLayout) } else { try c.encodeNil(forKey: .homeLayout) }
        }
        enum CodingKeys: String, CodingKey { case homeLayout }
    }

    /// PATCH /api/auth/me with the new arrangement (null = the default), optimistic.
    private func persist(_ next: HomeLayout, done: String?) async {
        guard let user = store.user else { return }
        let value: HomeLayout? = homeSameLayout(next, HomeWidgets.defaultLayout) ? nil : next
        var optimistic = user
        optimistic.homeLayout = value
        store.setUser(optimistic)
        saving = true
        defer { saving = false }
        do {
            let r: UserResponse = try await API.shared.send(.patch, "/api/auth/me", body: MePatch(homeLayout: value))
            store.setUser(r.user)
            if let done { store.toasts.show(done) }
        } catch {
            store.setUser(user)
            if let e = error as? APIError, e.isUnauthorized {
                store.report(error)
                return
            }
            if error is CancellationError { return }
            store.toasts.error("홈 배치를 저장하지 못했어요 · \((error as? LocalizedError)?.errorDescription ?? "요청을 처리하지 못했습니다")")
        }
    }
}
