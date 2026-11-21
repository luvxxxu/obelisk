import Observation
import SwiftUI

/// 선택 모드 on a task list (web lib/selection.ts): which rows are picked, which rows the page shows
/// (for 모두 선택 and ⌘A), and a batch of 10 or more waiting for its 휴지통 confirmation.
///
/// It lives on the Router because three places read it at once: the list (edit mode, the checkmarks),
/// the shell's top bar (N개 선택, 모두 선택) and the page's bottom bar, which replaces the composer.
@Observable
@MainActor
final class TaskSelection {
    /// Selection mode: the list is in edit mode (circles, two-finger pan), rows pick instead of open.
    private(set) var isActive = false
    /// Picked rows: task ids, or trash item ids on 휴지통.
    var ids: Set<String> = []
    /// Every row the page's list shows right now, top to bottom (collapsed groups left out). Empty when
    /// the page has no selectable list (home, a timeline, a pushed screen).
    private(set) var rows: [String] = []
    /// The list that registered `rows`: a page's old list may say goodbye after the new one said hello.
    private var owner: UUID?
    /// Which collapsible groups of the current page are folded. The groups read and write their fold
    /// here (no state of their own), so a rebuilt list and 모두 선택 always agree on what is hidden.
    private var collapsed: [String: Bool] = [:]
    /// From this many tasks on, moving them to the trash asks first (web CONFIRM_AT).
    static let confirmTrashAt = 10
    /// A batch of `confirmTrashAt` or more waiting for 휴지통으로 옮기기.
    var pendingTrash: [String] = []

    var canSelect: Bool { !rows.isEmpty }
    /// Picked rows in screen order (copies and toasts read top to bottom).
    var ordered: [String] { rows.filter(ids.contains) }
    var allPicked: Bool { !rows.isEmpty && rows.allSatisfy(ids.contains) }

    /// Enter selection mode, optionally with one row already picked (the row menu's 선택).
    func begin(with id: String? = nil) {
        guard canSelect else { return }
        // The composer goes under the bar: its keyboard goes with it.
        UIApplication.endEditing()
        Haptics.select()
        withAnimation(ObMotion.standard) {
            isActive = true
            if let id { ids = [id] }
        }
    }

    func end() {
        guard isActive || !ids.isEmpty else { return }
        withAnimation(ObMotion.standard) {
            isActive = false
            ids = []
        }
    }

    /// 모두 선택, or 선택 해제 when everything is already picked.
    func toggleAll() {
        Haptics.select()
        ids = allPicked ? [] : Set(rows)
    }

    /// ⌘A: into selection mode with every row picked.
    func selectAll() {
        guard canSelect else { return }
        if !isActive { begin() }
        ids = Set(rows)
    }

    // MARK: the list's rows

    /// Called by the page's list whenever what it shows changes. Picks that left the list (trashed,
    /// completed out of 인박스, folded away) are dropped so the bar never acts on rows nobody can see.
    func register(_ token: UUID, _ list: [String]) {
        owner = token
        if rows != list { rows = list }
        let kept = ids.intersection(list)
        if kept != ids { ids = kept }
    }

    /// The list left the screen (another page, a mode switch, a pushed task): selection mode ends with it.
    func unregister(_ token: UUID) {
        guard owner == token else { return }
        owner = nil
        rows = []
        isActive = false
        ids = []
    }

    /// A new page: nothing picked, every group back to its own default.
    func reset() {
        isActive = false
        ids = []
        pendingTrash = []
        collapsed = [:]
    }

    // MARK: collapsible groups

    /// Whether a group is folded: as last set on this page, else its own default.
    func isCollapsed(_ key: String, default value: Bool) -> Bool {
        collapsed[key] ?? value
    }

    func setCollapsed(_ key: String, _ value: Bool) {
        if collapsed[key] != value { collapsed[key] = value }
    }

    /// A group on screen keeps the default it appeared with, even when that default changes later
    /// (오늘 완료 folds from 4 tasks on, but not under you as you finish the 4th).
    func keepDefault(_ key: String, _ value: Bool) {
        if collapsed[key] == nil { collapsed[key] = value }
    }

    /// A group's rows as the list shows them: none while it is folded.
    func shown(_ key: String, _ tasks: [TaskItem], collapsedByDefault: Bool) -> [String] {
        isCollapsed(key, default: collapsedByDefault) ? [] : tasks.map(\.id)
    }
}
