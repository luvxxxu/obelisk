import SwiftUI

/// Jev dialogs other screens can open (web lib/ui-state.ts `JevDialog`).
enum JevDialog: Hashable, Sendable {
    /// Priority suggestions for open tasks.
    case priority
    /// What to postpone today / this week.
    case postpone(scope: JevPostponeScope)
}

enum JevPostponeScope: String, Hashable, Sendable {
    case today, week
}

extension Router {
    /// Open a Jev dialog as a sheet: `router.presentJev(.postpone(scope: .today))`.
    func presentJev(_ dialog: JevDialog) {
        present(.init(id: "jev", detents: [.large]) { JevDialogSheet(dialog: dialog) })
    }
}

/// The Jev dialog sheet (web components/JevDialogs.tsx): priority suggestions, or what to postpone.
/// Without a working key it explains and leads to 설정 › Jev.
struct JevDialogSheet: View {
    var dialog: JevDialog

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private var connected: Bool { store.user?.jev.connected == true }

    private var title: String {
        guard connected else { return "Jev" }
        switch dialog {
        case .priority: return "Jev 우선순위 제안"
        case .postpone: return "무엇을 미룰까요?"
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if connected {
                    switch dialog {
                    case .priority: JevPriorityDialog()
                    case let .postpone(scope): JevPostponeDialog(initialScope: scope)
                    }
                } else {
                    JevConnectPrompt(jev: store.user?.jev)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Ob.bg.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        JevMark(size: 14)
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("닫기")
                }
            }
        }
        .jevAutoPilot()
    }
}

/// The home dashboard's Jev strip (web components/JevStrip.tsx): "지금 할 일 하나" and the two Jev actions
/// when connected; otherwise a one-line, dismissible invitation (or a notice that the stored key must be
/// entered again).
///
/// - `todayCount`: tasks left for today (overdue + today); above 5 the postpone action is emphasised.
///   0 = count it here.
/// - `onDismiss`: on the home dashboard the ✕ hides the widget (홈에서 숨기기) instead of remembering
///   "다시 보지 않기" on this device.
struct JevStrip: View {
    var todayCount: Int
    var onDismiss: (() -> Void)?

    init(todayCount: Int = 0, onDismiss: (() -> Void)? = nil) {
        self.todayCount = todayCount
        self.onDismiss = onDismiss
    }

    @Environment(AppStore.self) private var store
    @AppStorage("obelisk:jev-invite-dismissed") private var inviteDismissed = false

    var body: some View {
        let jev = store.user?.jev
        if jev?.keyUnreadable == true {
            JevStripNotice(kind: .unreadable(hint: jev?.hint), onDismiss: onDismiss)
        } else if jev?.connected == true {
            JevStripCard(todayCount: todayCount)
        } else if onDismiss != nil || !inviteDismissed {
            JevStripNotice(kind: .invite, onDismiss: onDismiss) {
                withAnimation(ObMotion.standard) { inviteDismissed = true }
            }
        }
    }
}
