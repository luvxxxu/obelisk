import Foundation

// The home dashboard's widgets and the saved arrangement: a port of web/src/app/(app)/page.tsx `WIDGETS`
// and web/src/app/(app)/_home/layout.ts. iOS shows the web's narrow-screen layout (`mobile`: one
// column, order + hidden); the desktop grid is kept exactly as the web would save it, so a layout
// edited on the phone never disturbs the wide-screen one.

enum HomeWidgetChrome: Hashable {
    /// Fills its box with its own card.
    case bare
    /// Gets a page-section heading (and an optional lead) above its body.
    case section
}

/// A box on the web's 12-column desktop grid.
struct HomeGridBox: Hashable {
    var x: Int
    var y: Int
    var w: Int
    var h: Int
}

struct HomeWidgetDef: Identifiable, Hashable {
    let id: String
    /// Shown while editing and in the "위젯 추가" menu.
    let name: String
    let symbol: String
    let chrome: HomeWidgetChrome
    var lead: String?
    let minW: Int
    let minH: Int
    let desktop: HomeGridBox
    /// Two of these sit side by side (the summary tiles).
    var mobileHalf = false
}

enum HomeWidgets {
    private static func tile(_ id: String, _ name: String, _ symbol: String, _ x: Int, _ y: Int, _ w: Int = 3, _ h: Int = 6) -> HomeWidgetDef {
        HomeWidgetDef(id: id, name: name, symbol: symbol, chrome: .bare, minW: 2, minH: 5, desktop: .init(x: x, y: y, w: w, h: h), mobileHalf: true)
    }

    /// Every block of the home page. The array order is the default phone order.
    static let all: [HomeWidgetDef] = [
        HomeWidgetDef(id: "status", name: "지금 상황", symbol: "gauge.with.dots.needle.33percent", chrome: .bare, minW: 4, minH: 4, desktop: .init(x: 0, y: 0, w: 9, h: 6)),
        HomeWidgetDef(id: "jev", name: "Jev 추천", symbol: "scalemass", chrome: .bare, minW: 4, minH: 3, desktop: .init(x: 0, y: 6, w: 12, h: 3)),
        tile("tile-today", "오늘 남은 작업", "sun.max", 0, 9),
        tile("tile-overdue", "기한 지남", "exclamationmark.circle", 3, 9),
        tile("tile-delayed", "밀리는 작업", "waveform.path.ecg", 6, 9),
        tile("tile-conflicts", "고정 일정 충돌", "pin", 9, 9),
        tile("tile-finish", "전체 완료 예상", "flag", 9, 0),
        HomeWidgetDef(
            id: "ripple", name: "지연 파급", symbol: "waveform.path.ecg", chrome: .section,
            lead: "기한 지난 작업이 뒤따르는 일정을 얼마나 밀어내는지 미리 계산했어요.",
            minW: 4, minH: 8, desktop: .init(x: 0, y: 15, w: 8, h: 20)
        ),
        HomeWidgetDef(id: "watch", name: "주의할 작업", symbol: "scope", chrome: .bare, minW: 3, minH: 6, desktop: .init(x: 8, y: 15, w: 4, h: 20)),
        HomeWidgetDef(
            id: "spaces", name: "다른 공간", symbol: "square.grid.2x2", chrome: .section,
            lead: "지금 열지 않은 공간에서 기다리는 일이에요. 개인 공간은 전부, 조직은 나에게 배정된 일만 세요.",
            minW: 4, minH: 6, desktop: .init(x: 0, y: 35, w: 12, h: 10)
        ),
        HomeWidgetDef(id: "urgent", name: "급한 업무", symbol: "bolt", chrome: .section, minW: 4, minH: 10, desktop: .init(x: 0, y: 45, w: 6, h: 22)),
        HomeWidgetDef(id: "upcoming", name: "다가오는 일정", symbol: "calendar", chrome: .section, minW: 3, minH: 8, desktop: .init(x: 6, y: 45, w: 6, h: 22)),
        HomeWidgetDef(id: "projects", name: "진행 상황", symbol: "folder", chrome: .section, minW: 4, minH: 10, desktop: .init(x: 0, y: 67, w: 12, h: 20)),
    ]

    static let byId: [String: HomeWidgetDef] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static let defaultLayout: HomeLayout = homeDefaultLayout(all)
}

// MARK: - Grid helpers (layout.ts)

private let HOME_COLS = 12
private let HOME_MAX_H = 60

private func homeCollides(_ a: HomeLayoutItem, _ b: HomeLayoutItem) -> Bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

func homeClampItem(_ it: HomeLayoutItem, _ def: HomeWidgetDef?) -> HomeLayoutItem {
    let minW = def?.minW ?? 1
    let minH = def?.minH ?? 1
    let w = max(minW, min(HOME_COLS, it.w))
    let h = max(minH, min(HOME_MAX_H, it.h))
    let x = max(0, min(HOME_COLS - w, it.x))
    let y = max(0, it.y)
    return HomeLayoutItem(id: it.id, x: x, y: y, w: w, h: h, fixed: it.fixed == true ? true : nil)
}

private func homeByYX(_ a: HomeLayoutItem, _ b: HomeLayoutItem) -> Int {
    a.y != b.y ? a.y - b.y : a.x - b.x
}

/// Resolve overlaps and pack upward (layout.ts `settle` without an active widget).
func homeSettle(_ items: [HomeLayoutItem]) -> [HomeLayoutItem] {
    var placed: [HomeLayoutItem] = []
    for r in JS.sorted(items, homeByYX) {
        var it = r
        while placed.contains(where: { homeCollides(it, $0) }) { it.y += 1 }
        placed.append(it)
    }
    homeCompact(&placed)
    return placed
}

/// Float every widget up until it touches another; repeat until nothing moves.
private func homeCompact(_ list: inout [HomeLayoutItem]) {
    var moved = true
    while moved {
        moved = false
        let order = JS.sorted(Array(list.indices)) { homeByYX(list[$0], list[$1]) }
        for i in order {
            while list[i].y > 0 {
                var up = list[i]
                up.y -= 1
                if list.indices.contains(where: { $0 != i && homeCollides(up, list[$0]) }) { break }
                list[i].y -= 1
                moved = true
            }
        }
    }
}

private func homeBottom(_ items: [HomeLayoutItem]) -> Int {
    items.reduce(0) { max($0, $1.y + $1.h) }
}

/// Where a widget coming back goes: its default spot if free, else the first hole, else the bottom.
func homeFirstFit(_ items: [HomeLayoutItem], _ it: HomeLayoutItem) -> HomeLayoutItem {
    func free(_ c: HomeLayoutItem) -> Bool { !items.contains { homeCollides(c, $0) } }
    if free(it) { return it }
    let end = homeBottom(items)
    for y in 0 ..< max(0, end) {
        var x = 0
        while x + it.w <= HOME_COLS {
            var c = it
            c.x = x
            c.y = y
            if free(c) { return c }
            x += 1
        }
    }
    var c = it
    c.y = end
    return c
}

private func homeItem(_ d: HomeWidgetDef) -> HomeLayoutItem {
    HomeLayoutItem(id: d.id, x: d.desktop.x, y: d.desktop.y, w: d.desktop.w, h: d.desktop.h, fixed: nil)
}

func homeDefaultLayout(_ defs: [HomeWidgetDef]) -> HomeLayout {
    HomeLayout(
        v: 1,
        desktop: .init(items: homeSettle(defs.map(homeItem)), hidden: []),
        mobile: .init(order: defs.map(\.id), hidden: [])
    )
}

/// Make a saved layout safe to render: drop unknown widgets, clamp sizes, add widgets that are new
/// since it was saved (on the phone: appended to the order unless hidden).
func homeNormalize(_ saved: HomeLayout?, _ defs: [HomeWidgetDef]) -> HomeLayout {
    guard let saved, saved.v == 1 else { return homeDefaultLayout(defs) }
    let byId = Dictionary(uniqueKeysWithValues: defs.map { ($0.id, $0) })
    func uniq(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { byId[$0] != nil && seen.insert($0).inserted }
    }

    var seen = Set<String>()
    var items: [HomeLayoutItem] = []
    for it in saved.desktop.items {
        guard byId[it.id] != nil, !seen.contains(it.id) else { continue }
        seen.insert(it.id)
        items.append(homeClampItem(it, byId[it.id]))
    }
    let dHidden = uniq(saved.desktop.hidden).filter { !seen.contains($0) }
    var packed = homeSettle(items)
    for d in defs where !seen.contains(d.id) && !dHidden.contains(d.id) {
        packed.append(homeFirstFit(packed, homeClampItem(homeItem(d), d)))
    }

    var order = uniq(saved.mobile.order)
    let mHidden = uniq(saved.mobile.hidden).filter { !order.contains($0) }
    for d in defs where !order.contains(d.id) && !mHidden.contains(d.id) { order.append(d.id) }

    return HomeLayout(v: 1, desktop: .init(items: homeSettle(packed), hidden: dHidden), mobile: .init(order: order, hidden: mHidden))
}

func homeSameLayout(_ a: HomeLayout, _ b: HomeLayout) -> Bool {
    func key(_ l: HomeLayout) -> ([HomeLayoutItem], [String], [String], [String]) {
        (l.desktop.items.sorted { $0.id < $1.id }, l.desktop.hidden.sorted(), l.mobile.order, l.mobile.hidden.sorted())
    }
    let x = key(a)
    let y = key(b)
    return x.0 == y.0 && x.1 == y.1 && x.2 == y.2 && x.3 == y.3
}

/// Phone rows: half-width widgets pair up when two of them are next to each other.
/// Returns the order grouped into rows of one or two ids.
func homeMobileRows(_ order: [String], _ defs: [String: HomeWidgetDef]) -> [[String]] {
    var rows: [[String]] = []
    var i = 0
    while i < order.count {
        let id = order[i]
        if defs[id]?.mobileHalf == true, i + 1 < order.count, defs[order[i + 1]]?.mobileHalf == true {
            rows.append([id, order[i + 1]])
            i += 2
        } else {
            rows.append([id])
            i += 1
        }
    }
    return rows
}
