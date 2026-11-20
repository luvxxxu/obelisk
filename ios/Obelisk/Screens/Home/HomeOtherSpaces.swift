import SwiftUI

/// Home widget "다른 공간" (web _home/OtherSpaces.tsx): what waits for the user in every space other than
/// the open one (overdue, today and the next 7 days, plus the first thing up). Tapping a card opens that
/// space; the link below leads to 모아보기.
struct HomeOtherSpaces: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    private let feed = OverviewFeed.shared

    private struct Card: Identifiable {
        var space: WorkspaceSummary
        var overdue: Int
        var today: Int
        var week: Int
        var next: TaskItem?
        var when: String?
        var id: String { space.id }
    }

    var body: some View {
        let merged = feed.merged(store)
        let today = store.today
        let openId = store.workspace?.id
        let cards = merged.spaces.filter { $0.id != openId }.map { w -> Card in
            let sec = overviewSections(merged.items.filter { $0.space.id == w.id }.map(\.task), today)
            let week = sec.week.reduce(0) { $0 + $1.tasks.count }
            let nextDay = sec.week.first { !$0.tasks.isEmpty }
            let next = sec.overdue.first ?? sec.today.first ?? nextDay?.tasks.first
            let when: String? = !sec.overdue.isEmpty ? "기한 지남" : !sec.today.isEmpty ? "오늘" : nextDay.map { formatRelativeKo($0.date, today) }
            return Card(space: w, overdue: sec.overdue.count, today: sec.today.count, week: week, next: next, when: when)
        }

        Group {
            if !feed.loaded(for: store) {
                HStack(spacing: ObSpace.sm) {
                    if let error = feed.errorText(for: store) {
                        Text("다른 공간을 불러오지 못했어요 · \(error)")
                    } else {
                        ProgressView().controlSize(.small)
                        Text("다른 공간 불러오는 중")
                    }
                }
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                .padding(.horizontal, ObSpace.xs)
            } else if cards.isEmpty {
                HStack(alignment: .top, spacing: ObSpace.md) {
                    Image(systemName: "building.2")
                        .font(.system(size: 17))
                        .foregroundStyle(Ob.text3)
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("다른 공간이 없어요")
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                        Text("조직에 참여하면 그곳에서 나에게 배정된 일이 여기 요약돼요.")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .obCard()
                .accessibilityElement(children: .combine)
            } else {
                VStack(alignment: .leading, spacing: ObSpace.md) {
                    ForEach(cards) { card($0) }
                    HomeMoreLink(label: "모아보기에서 모든 공간 보기") { router.open(.overview) }
                }
            }
        }
        .task(id: store.user?.id) { await feed.keepFresh(store) }
        .onChange(of: store.workspace?.id) { _, id in
            if id != nil { Task { await feed.load(store) } }
        }
    }

    private func card(_ c: Card) -> some View {
        Button {
            open(c.space)
        } label: {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                HStack(spacing: ObSpace.sm) {
                    HomeSpaceMark(space: c.space)
                    Text(homeSpaceLabel(c.space))
                        .font(ObFont.bodyStrong)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Ob.text4)
                }
                HStack(alignment: .top, spacing: ObSpace.sm) {
                    stat("기한 지남", c.overdue, danger: true)
                    stat("오늘", c.today, danger: false)
                    stat("\(OVERVIEW_DAYS)일 안", c.week, danger: false)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Hairline()
                        .padding(.bottom, ObSpace.md)
                    HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                        if let next = c.next {
                            Text(c.when ?? "")
                                .font(ObFont.caption.weight(.medium))
                                .foregroundStyle(c.overdue > 0 ? Ob.dangerText : Ob.text3)
                                .fixedSize()
                            Text(next.title)
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text)
                                .lineLimit(1)
                        } else {
                            Text("\(OVERVIEW_DAYS)일 안에 맡은 일이 없어요")
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text3)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(ObSpace.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.lg))
        }
        .buttonStyle(HomeCardButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("\(homeSpaceLabel(c.space))(으)로 전환")
        .contextMenu {
            Button {
                open(c.space)
            } label: {
                Label("이 공간 열기", systemImage: "arrow.up.right")
            }
            Button {
                router.open(.overview)
            } label: {
                Label("모아보기에서 보기", systemImage: "square.grid.2x2")
            }
        }
    }

    private func open(_ space: WorkspaceSummary) {
        Haptics.select()
        let store = self.store
        Task {
            await store.switchWorkspace(space.id)
            if store.workspace?.id == space.id { store.toasts.show("\(homeSpaceLabel(space))(으)로 전환했어요") }
        }
    }

    private func stat(_ label: String, _ n: Int, danger: Bool) -> some View {
        let tone = n > 0 && danger
        return VStack(alignment: .leading, spacing: 2) {
            Text("\(n)")
                .font(ObFont.title3.monospacedDigit())
                .foregroundStyle(tone ? Ob.dangerText : (n == 0 ? Ob.text4 : Ob.text))
            Text(label)
                .font(ObFont.caption)
                .foregroundStyle(tone ? Ob.dangerText : Ob.text3)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
