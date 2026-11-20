import SwiftUI

/// Home: "지금 할 일 하나" from Jev plus the two Jev actions (web components/JevStrip.tsx, connected state).
struct JevStripCard: View {
    /// Tasks left today as the home counts them; 0 = count here.
    var todayCount: Int

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    private var center: JevCenter { .shared }

    /// Overdue + due today, like the home's 오늘 남은 작업 (store.now is the app's minute clock).
    private var count: Int {
        if todayCount > 0 { return todayCount }
        let now = store.now
        let tasks = store.taskList
        let overdue = selectView(tasks, .overdue, store.today, now)
        let todays = selectView(tasks, .today, store.today).filter { !isOverdue($0, store.today, now) }
        return overdue.count + todays.count
    }

    var body: some View {
        let data = center.data
        let focus = data?.focus.flatMap { f in store.task(f.taskId).map { (task: $0, reasons: f.reasons) } }
        let changes = (data?.suggestions ?? []).filter { sg in store.task(sg.taskId).map { sg.suggested != $0.priority } ?? false }.count
        let count = count
        let busy = count > 5

        HStack(alignment: .top, spacing: ObSpace.md) {
            JevMark()
                .frame(height: 18)
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                Text("Jev 추천 · 지금 할 일")
                    .font(ObFont.caption.weight(.medium))
                    .foregroundStyle(Ob.text3)

                Group {
                    if center.phase == .loading || center.phase == .idle, data == nil {
                        VStack(alignment: .leading, spacing: 6) {
                            JevSkeleton(width: 220, height: 15)
                            JevSkeleton(width: 160, height: 11)
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement()
                        .accessibilityLabel("Jev가 살펴보는 중")
                    } else if center.phase == .error, data == nil {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(center.error ?? "Jev에 묻지 못했어요")
                                .font(ObFont.sub)
                                .foregroundStyle(Ob.text2)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("다시 시도") {
                                Task { await center.refreshPriorities(store, force: true) }
                            }
                            .font(ObFont.sub.weight(.medium))
                            .foregroundStyle(Ob.text)
                            .underline(color: Ob.borderStrong)
                            .frame(minHeight: 32)
                        }
                    } else if let focus {
                        VStack(alignment: .leading, spacing: 2) {
                            JevTaskName(task: focus.task, strong: true)
                            JevReasons(reasons: focus.reasons)
                        }
                    } else {
                        Text("지금 바로 시작할 일은 없어요. 다가오는 일정을 확인해 보세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .animation(ObMotion.standard, value: center.phase)

                HStack(spacing: ObSpace.sm) {
                    Button {
                        router.presentJev(.priority)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "flag").font(.system(size: 13, weight: .medium))
                            Text("우선순위 정리")
                            if changes > 0 {
                                Text("\(changes)")
                                    .font(ObFont.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(Ob.text3)
                            }
                        }
                    }
                    .buttonStyle(.ob(.ghost, size: .small))
                    .accessibilityLabel(changes > 0 ? "우선순위 정리, 바꿀 작업 \(changes)개" : "우선순위 정리")

                    Button {
                        router.presentJev(.postpone(scope: .today))
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "calendar.badge.clock").font(.system(size: 13, weight: .medium))
                            Text("미룰 작업 고르기")
                        }
                    }
                    .buttonStyle(.ob(busy ? .outline : .ghost, size: .small))
                    .accessibilityHint(busy ? "오늘 할 일이 \(count)개예요" : "")
                }
                .padding(.top, ObSpace.xs)
                .padding(.leading, -12)
            }
            Spacer(minLength: 0)
        }
        .obCard(padding: ObSpace.lg)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jev 추천")
        .modifier(JevPrioritiesFollower(enabled: true))
        .jevAutoPilot()
    }
}

/// Without a working key: a one-line invitation to connect, or a notice that the stored key must be
/// entered again (retrying would never help). Hairline card like the connected strip.
struct JevStripNotice: View {
    enum Kind: Equatable {
        case invite
        case unreadable(hint: String?)
    }

    var kind: Kind
    var onDismiss: (() -> Void)?
    /// The invite's own "다시 보지 않기" (used when the home doesn't handle hiding).
    var dismissHere: (() -> Void)?

    @Environment(Router.self) private var router

    init(kind: Kind, onDismiss: (() -> Void)?, dismissHere: (() -> Void)? = nil) {
        self.kind = kind
        self.onDismiss = onDismiss
        self.dismissHere = dismissHere
    }

    private var text: String {
        switch kind {
        case .invite:
            "**Jev**를 연결하면 우선순위를 정해 주고, 일이 몰리는 날엔 미뤄도 되는 일을 골라 드려요."
        case let .unreadable(hint):
            "**Jev 키를 다시 입력해 주세요.** 저장된 키\(hint.map { "(…\($0))" } ?? "")를 이 서버의 암호화 키로 열 수 없어요."
        }
    }

    /// Hide action: the home's (홈에서 숨기기), else the invite's own (다시 보지 않기); none for the key notice.
    private var hide: (label: String, run: () -> Void)? {
        if let onDismiss { return ("홈에서 숨기기", onDismiss) }
        if kind == .invite, let dismissHere { return ("다시 보지 않기", dismissHere) }
        return nil
    }

    var body: some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            JevMark()
                .frame(height: 20)
            VStack(alignment: .leading, spacing: ObSpace.md) {
                Text(jevRich(text))
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    router.openSettings(.jev)
                } label: {
                    HStack(spacing: 5) {
                        Text(kind == .invite ? "연결하기" : "키 다시 입력")
                        Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold))
                    }
                }
                .buttonStyle(.ob(.outline, size: .small))
            }
            Spacer(minLength: 0)
            if let hide {
                Button(action: hide.run) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Ob.text3)
                        .frame(width: ObSize.row, height: ObSize.row)
                        .contentShape(Rectangle())
                }
                .buttonStyle(JevPressStyle())
                .padding(.top, -12)
                .padding(.trailing, -12)
                .accessibilityLabel(hide.label)
            }
        }
        .obCard(padding: ObSpace.lg)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(kind == .invite ? [] : .isStaticText)
    }
}
