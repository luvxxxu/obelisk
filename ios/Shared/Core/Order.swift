import Foundation

// Port of packages/core/src/order.ts.
//
// Manual ordering with fractional positions (board cards, lists). A drop writes one number — the
// midpoint of its new neighbours — and only renumbers the list when two neighbours are too close.

/// Gap between items when a list is (re)numbered.
let POSITION_STEP: Double = 1024
/// Below this gap a midpoint is no longer reliably distinct, so the list gets renumbered.
private let MIN_GAP = 1e-6

/// Position for an item placed between `before` and `after` (either may be missing).
/// Returns nil when there is no room between them and the list must be renumbered with `spread`.
func positionBetween(_ before: Double? = nil, _ after: Double? = nil) -> Double? {
    switch (before, after) {
    case (nil, nil): return POSITION_STEP
    case let (nil, a?): return a - POSITION_STEP
    case let (b?, nil): return b + POSITION_STEP
    case let (b?, a?):
        if a - b <= MIN_GAP { return nil }
        return b + (a - b) / 2
    }
}

/// One entry of `spread`.
struct SpreadItem: Codable, Hashable, Sendable {
    var id: String
    var position: Double
}

/// Evenly spaced positions for `ids`, in order.
func spread(_ ids: [String], _ step: Double = POSITION_STEP) -> [SpreadItem] {
    ids.enumerated().map { SpreadItem(id: $0.element, position: Double($0.offset + 1) * step) }
}
