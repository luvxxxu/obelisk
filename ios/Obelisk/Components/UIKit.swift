import SwiftUI

// Obelisk's small component vocabulary (the web's primitives.tsx / ui.module.css on iOS).
// House rules: pure bases, hairlines not grey fills, no shadows on resting things, colour only for meaning,
// pills for buttons, radius 10 rows / 16 cards / 20 sheets, calm motion. Glass only on floating chrome.

// MARK: - Buttons

enum ObButtonKind {
    /// Monochrome filled pill (black on light, white on dark).
    case primary
    /// Hairline pill.
    case outline
    /// Text-only, quiet fill when pressed.
    case ghost
    /// Destructive filled pill.
    case danger
    /// Destructive text.
    case dangerGhost
}

struct ObButtonStyle: ButtonStyle {
    var kind: ObButtonKind = .primary
    var size: ControlSize = .regular
    var fullWidth = false

    @Environment(\.isEnabled) private var isEnabled

    private var height: CGFloat {
        switch size {
        case .mini, .small: ObSize.controlSm
        case .large, .extraLarge: ObSize.controlLg
        default: ObSize.control
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(size == .small || size == .mini ? ObFont.footnote.weight(.medium) : ObFont.body.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, size == .small || size == .mini ? 12 : 18)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: height)
            .foregroundStyle(foreground)
            .background(background(pressed: configuration.isPressed), in: Capsule())
            .overlay {
                if kind == .outline { Capsule().strokeBorder(Ob.borderStrong, lineWidth: 1) }
            }
            .contentShape(Capsule())
            .opacity(isEnabled ? 1 : 0.4)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary: Ob.onPrimary
        case .outline, .ghost: Ob.text
        case .danger: .white
        case .dangerGhost: Ob.dangerText
        }
    }

    private func background(pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? Ob.primaryHover : Ob.primary
        case .outline, .ghost: pressed ? Ob.surface3 : (kind == .ghost ? .clear : Ob.bg)
        case .danger: Ob.dangerSolid.opacity(pressed ? 0.85 : 1)
        case .dangerGhost: pressed ? Ob.dangerSoft : .clear
        }
    }
}

extension ButtonStyle where Self == ObButtonStyle {
    static var obPrimary: ObButtonStyle { ObButtonStyle(kind: .primary) }
    static var obOutline: ObButtonStyle { ObButtonStyle(kind: .outline) }
    static var obGhost: ObButtonStyle { ObButtonStyle(kind: .ghost) }
    static var obDanger: ObButtonStyle { ObButtonStyle(kind: .danger) }
    static func ob(_ kind: ObButtonKind, size: ControlSize = .regular, fullWidth: Bool = false) -> ObButtonStyle {
        ObButtonStyle(kind: kind, size: size, fullWidth: fullWidth)
    }
}

/// A row-shaped press highlight (radius 10, quiet fill) for tappable rows that aren't List rows.
struct ObRowButtonStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.md))
            .background(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .fill(configuration.isPressed ? Ob.surface3 : (selected ? Ob.surface3 : .clear))
            )
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == ObRowButtonStyle {
    static var obRow: ObRowButtonStyle { ObRowButtonStyle() }
    static func obRow(selected: Bool) -> ObRowButtonStyle { ObRowButtonStyle(selected: selected) }
}

// MARK: - Surfaces

extension View {
    /// A resting card: pure base, hairline, radius 16, no shadow.
    func obCard(padding: CGFloat = ObSpace.lg, radius: CGFloat = ObRadius.lg) -> some View {
        self.padding(padding)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Ob.border, lineWidth: 1))
    }

    /// A faint well (board columns, callouts): alpha tint, radius 16.
    func obWell(padding: CGFloat = ObSpace.md, radius: CGFloat = ObRadius.lg) -> some View {
        self.padding(padding).background(Ob.tint, in: RoundedRectangle(cornerRadius: radius))
    }

    /// A semantic callout (warn/danger/info/ok): soft tint, radius 10, no edge stripe.
    func obCallout(_ tone: Tone, padding: CGFloat = ObSpace.md) -> some View {
        self.padding(padding).background(tone.soft, in: RoundedRectangle(cornerRadius: ObRadius.md))
    }

    /// Pure page background, edge to edge.
    func obPage() -> some View {
        self.background(Ob.bg.ignoresSafeArea())
    }

    /// Floating chrome: Liquid Glass capsule (top-bar buttons, composer, toasts).
    func obGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        self.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }
}

/// Hairline (web 1px --border, which is 1pt on a phone).
struct Hairline: View {
    var vertical = false
    var color: Color = Ob.border
    var body: some View {
        Rectangle().fill(color)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
            .accessibilityHidden(true)
    }
}

// MARK: - Headers

/// Page title as the web shows it under the top bar: big, semibold, with an optional muted lead.
struct PageHeader<Trailing: View>: View {
    var title: String
    var subtitle: String?
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, subtitle: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                Text(title)
                    .font(ObFont.title)
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                }
            }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.sm)
        .padding(.bottom, ObSpace.md)
    }
}

/// A section label inside a page or list: muted, sentence case, optional count and trailing action.
struct SectionLabel<Trailing: View>: View {
    var title: String
    var count: Int?
    var tone: Tone = .neutral
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, count: Int? = nil, tone: Tone = .neutral, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.count = count
        self.tone = tone
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            Text(title)
                .font(ObFont.footnote.weight(.semibold))
                .foregroundStyle(tone == .neutral ? Ob.text2 : tone.text)
            if let count {
                Text("\(count)")
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
            }
            Spacer(minLength: 0)
            trailing()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Empty state

struct EmptyState<Action: View>: View {
    var title: String
    var message: String?
    @ViewBuilder var action: () -> Action

    init(_ title: String, message: String? = nil, @ViewBuilder action: @escaping () -> Action = { EmptyView() }) {
        self.title = title
        self.message = message
        self.action = action
    }

    var body: some View {
        VStack(spacing: ObSpace.sm) {
            Text(title)
                .font(ObFont.bodyStrong)
                .foregroundStyle(Ob.text)
            if let message {
                Text(message)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .multilineTextAlignment(.center)
            }
            action()
                .padding(.top, ObSpace.sm)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, ObSpace.xxxl)
        .padding(.horizontal, ObSpace.xxl)
    }
}

// MARK: - Tags and counts

/// Project tag: swatch + name on the project's alpha tint (web .tag).
struct ProjectTag: View {
    var project: Project
    var compact = false

    var body: some View {
        let p = project.color.palette
        HStack(spacing: 5) {
            Circle().fill(p.ink).frame(width: 6, height: 6)
            Text(project.name)
                .lineLimit(1)
        }
        .font(ObFont.caption.weight(.medium))
        .foregroundStyle(p.text)
        .padding(.horizontal, compact ? 6 : 8)
        .frame(height: 22)
        .background(p.bg, in: RoundedRectangle(cornerRadius: ObRadius.xs))
    }
}

/// Small square colour swatch for a project (sidebar rows, pickers).
struct ProjectSwatch: View {
    var color: ProjectColor?
    var size: CGFloat = 10
    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(color?.palette.ink ?? Ob.text4)
            .frame(width: size, height: size)
    }
}

/// A neutral or semantic text chip (dates, statuses): no dot, no pill + dot.
struct Chip: View {
    var text: String
    var symbol: String?
    var tone: Tone = .neutral
    var filled = false

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text).lineLimit(1)
        }
        .font(ObFont.caption.weight(.medium))
        .foregroundStyle(tone == .neutral ? Ob.text2 : tone.text)
        .padding(.horizontal, filled ? 7 : 0)
        .frame(height: filled ? 22 : nil)
        .background {
            if filled { RoundedRectangle(cornerRadius: ObRadius.xs).fill(tone == .neutral ? Ob.surface2 : tone.soft) }
        }
    }
}

/// Muted count number (sidebar); red when something is overdue, orange when slipping.
struct CountText: View {
    var count: Int
    var tone: Tone = .neutral
    var body: some View {
        Text("\(count)")
            .font(ObFont.footnote.monospacedDigit())
            .foregroundStyle(tone == .neutral ? Ob.text3 : tone.text)
    }
}

/// Round initial avatar (account, members).
struct Avatar: View {
    var name: String
    var size: CGFloat = 28
    var body: some View {
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(Ob.text)
            .frame(width: size, height: size)
            .background(Ob.surface3, in: Circle())
            .accessibilityHidden(true)
    }
}

/// Overlapping initials, at most `limit` of them, then "+N" (web .stack): a team's members, a task's
/// assignees. Each circle is ringed in the page colour so the overlap reads as separate people.
struct AvatarStack: View {
    var names: [String]
    var size: CGFloat = 24
    var limit = 3

    var body: some View {
        if !names.isEmpty {
            let shown = names.count > limit ? limit : names.count
            HStack(spacing: -(size * 0.3).rounded()) {
                ForEach(Array(names.prefix(shown).enumerated()), id: \.offset) { _, n in
                    Avatar(name: n, size: size)
                        .overlay(Circle().strokeBorder(Ob.bg, lineWidth: size < 20 ? 1.5 : 2))
                }
                if names.count > shown {
                    Text("+\(names.count - shown)")
                        .font((size < 20 ? ObFont.footnote : ObFont.caption).monospacedDigit())
                        .foregroundStyle(Ob.text3)
                        .padding(.leading, (size * 0.3).rounded() + 3)
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// The Obelisk mark (template image from the asset catalog).
struct LogoMark: View {
    var size: CGFloat = 24
    var body: some View {
        Image("Logo")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Ob.text)
            .accessibilityLabel("Obelisk")
    }
}

// MARK: - Fields

/// Bordered text field (radius 10, hairline that darkens on focus).
struct ObFieldStyle: TextFieldStyle {
    var focused = false
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(ObFont.body)
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.controlLg)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(focused ? Ob.text3 : Ob.input, lineWidth: 1)
            )
    }
}

extension TextFieldStyle where Self == ObFieldStyle {
    static var ob: ObFieldStyle { ObFieldStyle() }
    static func ob(focused: Bool) -> ObFieldStyle { ObFieldStyle(focused: focused) }
}

/// One settings-style row: title + muted help on the left, control on the right (web settings Row).
struct SettingRow<Control: View>: View {
    var title: String
    var help: String?
    var stacked = false
    @ViewBuilder var control: () -> Control

    var body: some View {
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    labels
                    control()
                }
            } else {
                HStack(alignment: .center, spacing: ObSpace.md) {
                    labels
                    Spacer(minLength: ObSpace.sm)
                    control()
                }
            }
        }
        .padding(.vertical, ObSpace.md)
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(ObFont.body).foregroundStyle(Ob.text)
            if let help {
                Text(help).font(ObFont.footnote).foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Loading

/// The one allowed loop: a spinner while something is actually loading.
struct LoadingView: View {
    var label: String?
    var body: some View {
        VStack(spacing: ObSpace.sm) {
            ProgressView()
            if let label { Text(label).font(ObFont.footnote).foregroundStyle(Ob.text3) }
        }
        .frame(maxWidth: .infinity, minHeight: 160)
    }
}

// MARK: - Toggles

/// The web's switch (ui.module.css `.switch`): monochrome track when on (black on light, white on dark)
/// with a contrasting knob, hairline-strong track when off. The system switch tinted with the app's
/// monochrome primary would put a white knob on a white track in dark mode.
/// Applied once at the root, so every Toggle in the app (sheets included) picks it up.
struct ObSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: ObSpace.md) {
            configuration.label
            Spacer(minLength: 0)
            ObSwitchTrack(isOn: configuration.isOn)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            Haptics.select()
            configuration.isOn.toggle()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "켬" : "끔")
        .accessibilityAction { configuration.isOn.toggle() }
    }
}

private struct ObSwitchTrack: View {
    var isOn: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule().fill(isOn ? Ob.primary : Ob.borderStrong)
            Circle()
                .fill(isOn ? Ob.onPrimary : (scheme == .dark ? Ob.text : Ob.bg))
                .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
                .padding(2)
        }
        .frame(width: 46, height: 28)
        .opacity(isEnabled ? 1 : 0.4)
        .animation(ObMotion.standard, value: isOn)
        .accessibilityHidden(true)
    }
}

extension ToggleStyle where Self == ObSwitchStyle {
    static var obSwitch: ObSwitchStyle { ObSwitchStyle() }
}

// MARK: - Settings-style lists

extension View {
    /// A settings-style List on the pure base: plain rows with hairline separators and quiet section
    /// labels, never the system's grey grouped cells. Pair with `.obSettingsRow()` on each row.
    func obSettingsList() -> some View {
        self
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Ob.bg)
            .environment(\.defaultMinListRowHeight, ObSize.row)
    }

    func obSettingsRow() -> some View {
        self
            .listRowBackground(Ob.bg)
            .listRowSeparatorTint(Ob.border)
            .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
    }
}

/// Section header for settings-style lists (sentence case, muted, no system uppercase).
struct ObListHeader: View {
    var title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title)
            .font(ObFont.footnote.weight(.semibold))
            .foregroundStyle(Ob.text3)
            .textCase(nil)
            .padding(.top, ObSpace.md)
    }
}
