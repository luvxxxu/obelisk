import SwiftUI

// Small pieces the Jev dialogs and the home strip share (web components/JevDialogs.tsx + Jev.module.css).
// Monochrome: Jev has no colour of its own. Its mark is the plain scale in muted ink; colour appears only
// where it means something (priority ink on the flag, warn = over capacity, ok = calm).

/// The Jev mark: a small monochrome scale (Jev weighs decisions).
struct JevMark: View {
    var size: CGFloat = 16
    var body: some View {
        Image(systemName: "scalemass")
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(Ob.text2)
            .accessibilityHidden(true)
    }
}

/// Priority ink (web PRIORITY_TONE): 없음 muted, 낮음 info, 보통 warn, 높음 danger.
func jevPriorityInk(_ p: Priority) -> Color {
    switch p {
    case 3: Ob.danger
    case 2: Ob.warn
    case 1: Ob.info
    default: Ob.text3
    }
}

func jevPriorityLabel(_ p: Priority) -> String {
    PriorityInfo.labelKo[p] ?? "없음"
}

/// Priority as plain text with a small flag in the priority's ink (no pill, no dot).
struct JevPriorityText: View {
    var priority: Priority
    var strong = false
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: priority == 0 ? "flag" : "flag.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(jevPriorityInk(priority))
            Text(jevPriorityLabel(priority))
                .font(ObFont.caption.weight(strong ? .semibold : .regular))
                .foregroundStyle(strong ? Ob.text : Ob.text3)
        }
        .fixedSize()
    }
}

/// "높음 → 보통" with the new level emphasised.
struct JevPriorityChange: View {
    var from: Priority
    var to: Priority
    var body: some View {
        HStack(spacing: 4) {
            JevPriorityText(priority: from)
            Image(systemName: "arrow.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Ob.text3)
            JevPriorityText(priority: to, strong: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("우선순위 \(jevPriorityLabel(from))에서 \(jevPriorityLabel(to))로")
    }
}

/// Jev's certainty as a short bar + percent; darker once it counts as 확신 (≥ 80%).
struct JevConfidence: View {
    var value: Double
    var body: some View {
        let pct = Int((value * 100).rounded())
        let sure = value >= JEV_CONFIDENT
        HStack(spacing: 6) {
            Capsule()
                .fill(Ob.surface3)
                .frame(width: 28, height: 4)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(sure ? Ob.text : Ob.text3)
                        .frame(width: 28 * min(1, max(0, value)))
                }
            Text("\(pct)%")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(sure ? Ob.text2 : Ob.text3)
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Jev 확신도 \(pct)%")
    }
}

/// Square checkbox for picking a suggestion (44 pt target).
struct JevPick: View {
    var checked: Bool
    var label: String
    var toggle: () -> Void

    var body: some View {
        Button {
            Haptics.select()
            toggle()
        } label: {
            RoundedRectangle(cornerRadius: ObRadius.xs - 1)
                .fill(checked ? Ob.primary : Color.clear)
                .overlay {
                    RoundedRectangle(cornerRadius: ObRadius.xs - 1)
                        .strokeBorder(checked ? Ob.primary : Ob.borderStrong, lineWidth: 1.5)
                }
                .overlay {
                    if checked {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Ob.onPrimary)
                    }
                }
                .frame(width: 20, height: 20)
                .frame(width: ObSize.row, height: ObSize.row)
                .contentShape(Rectangle())
                .animation(ObMotion.fast, value: checked)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(checked ? "선택됨" : "선택 안 됨")
        .accessibilityAddTraits(.isToggle)
    }
}

/// "#12 제목": opens the task (and closes the sheet it sits in).
struct JevTaskName: View {
    var task: TaskItem
    var strong = false
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            router.openTask(task.id)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("#\(task.number)")
                    .font(ObFont.caption.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                Text(task.title)
                    .font(strong ? ObFont.body.weight(.medium) : ObFont.body)
                    .foregroundStyle(Ob.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(JevPressStyle())
        .accessibilityLabel("#\(task.number) \(task.title)")
        .accessibilityHint("작업 열기")
    }
}

struct JevPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

/// Reasons line: "꼭 해야 하는 일 · 내일 마감 · 2개 작업이 기다림".
struct JevReasons: View {
    var reasons: [String]
    var lines = 2
    var body: some View {
        if !reasons.isEmpty {
            Text(reasons.joined(separator: " · "))
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text3)
                .lineLimit(lines)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A static placeholder block while Jev is answering (no shimmer: the spinner is the one loop).
struct JevSkeleton: View {
    var width: CGFloat?
    var height: CGFloat = 14
    var body: some View {
        RoundedRectangle(cornerRadius: ObRadius.xs)
            .fill(Ob.surface2)
            .frame(width: width, height: height)
            .accessibilityHidden(true)
    }
}

/// "Jev가 … 살펴보는 중…" with a spinner and four placeholder rows.
struct JevLoadingRows: View {
    var label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: ObSpace.sm) {
                ProgressView().controlSize(.small)
                Text(label)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)
            }
            .padding(.bottom, ObSpace.md)
            ForEach(0 ..< 4, id: \.self) { i in
                HStack(spacing: ObSpace.md) {
                    JevSkeleton(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 6) {
                        JevSkeleton(width: CGFloat(220 - i * 28), height: 14)
                        JevSkeleton(width: 96, height: 10)
                    }
                    Spacer(minLength: 0)
                    JevSkeleton(width: 56, height: 18)
                }
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) { Hairline() }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

/// A failed Jev call: the server's message, and either 다시 시도 or a way to the Jev settings when
/// retrying can't help (no key, a key to enter again, a wrong key).
struct JevFailure: View {
    var message: String
    var retry: () -> Void
    @Environment(Router.self) private var router

    private var notConnected: Bool {
        ["연결되어 있지 않", "다시 입력", "올바르지 않"].contains { message.contains($0) }
    }

    var body: some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 16))
                .foregroundStyle(Ob.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: ObSpace.sm) {
                Text(message)
                    .font(ObFont.sub.weight(.medium))
                    .foregroundStyle(Ob.dangerText)
                    .fixedSize(horizontal: false, vertical: true)
                if notConnected {
                    Button("Jev 설정 열기") {
                        router.dismissSheet()
                        router.openSettings(.jev)
                    }
                    .buttonStyle(.ob(.outline, size: .small))
                } else {
                    Button("다시 시도", action: retry)
                        .buttonStyle(.ob(.outline, size: .small))
                }
            }
            Spacer(minLength: 0)
        }
        .obCallout(.danger)
        .accessibilityElement(children: .contain)
    }
}

/// A quiet "nothing to do" line in a well.
struct JevCalm: View {
    var text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 17))
                .foregroundStyle(Ob.ok)
                .accessibilityHidden(true)
            Text(text)
                .font(ObFont.sub)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(ObSpace.md)
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.lg))
    }
}

/// A titled group of hairline rows; the last group ("그대로 둘 작업") folds.
struct JevGroup<Rows: View>: View {
    var title: String
    var count: Int
    var hint: String?
    var collapsible = false
    @ViewBuilder var rows: () -> Rows

    @State private var open: Bool

    init(_ title: String, count: Int, hint: String? = nil, collapsible: Bool = false, @ViewBuilder rows: @escaping () -> Rows) {
        self.title = title
        self.count = count
        self.hint = hint
        self.collapsible = collapsible
        self.rows = rows
        _open = State(initialValue: !collapsible)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard collapsible else { return }
                withAnimation(ObMotion.standard) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Text(title)
                        .font(ObFont.sub.weight(.semibold))
                        .foregroundStyle(Ob.text2)
                    Text("\(count)")
                        .font(ObFont.footnote.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    if let hint {
                        Text(hint)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if collapsible {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Ob.text3)
                            .rotationEffect(.degrees(open ? 180 : 0))
                    }
                }
                .frame(minHeight: collapsible ? ObSize.row : 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(JevPressStyle())
            .disabled(!collapsible)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(collapsible ? (open ? "펼쳐짐" : "접힘") : "")

            if open {
                VStack(spacing: 0) {
                    Hairline()
                    rows()
                }
                .transition(.opacity)
            }
        }
    }
}

/// One suggestion row: pick (or a muted icon) · task + reasons · side details. Hairline under it.
struct JevRow<Lead: View, Side: View>: View {
    var off = false
    @ViewBuilder var lead: () -> Lead
    var task: TaskItem
    var reasons: [String]
    @ViewBuilder var side: () -> Side

    var body: some View {
        HStack(alignment: .top, spacing: ObSpace.xs) {
            lead()
                .frame(width: ObSize.row)
                .padding(.leading, -ObSpace.md)
            VStack(alignment: .leading, spacing: 4) {
                JevTaskName(task: task)
                JevReasons(reasons: reasons)
                side()
                    .padding(.top, 2)
            }
            .padding(.vertical, 11)
            .opacity(off ? 0.55 : 1)
            .animation(ObMotion.standard, value: off)
        }
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// Footer bar of a Jev sheet: a muted note above one primary action.
struct JevFooter<Label: View>: View {
    var note: String
    var disabled: Bool
    var busy: Bool
    var action: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        VStack(spacing: ObSpace.sm) {
            Text(note)
                .font(ObFont.caption)
                .foregroundStyle(Ob.text3)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            Button(action: action) {
                HStack(spacing: 6) {
                    if busy {
                        ProgressView().controlSize(.small).tint(Ob.onPrimary)
                    }
                    label()
                }
            }
            .buttonStyle(.ob(.primary, size: .large, fullWidth: true))
            .disabled(disabled)
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.md)
        .padding(.bottom, ObSpace.sm)
        .background(Ob.bg)
        .overlay(alignment: .top) { Hairline() }
    }
}
