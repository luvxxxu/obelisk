import SwiftUI
import UIKit

/*
 Obelisk design tokens for iOS: a 1:1 port of web/src/app/globals.css.

 Light base #ffffff, dark base #000000, everywhere content lives (pages, sidebar, cards, sheets' content).
 Surfaces are separated by hairlines and faint alpha fills, never by grey bases.
 Neutral ink only. Colour means something or it is not used:
 danger = overdue/conflict · warn = slipping · ok = done/on track · info = in progress · project hue = identity.
 Primary is monochrome (black on light, white on dark).

 Liquid Glass is for system chrome and things that float above content (top-bar buttons, the composer,
 toasts, menus). Cards, rows and pages stay pure. See ios/README.md for the house rules.
 */

// MARK: - Colour helpers

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    /// A light/dark pair, like CSS `light-dark()`.
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }

    init(light: UInt32, dark: UInt32) {
        self.init(light: UIColor(hex: light), dark: UIColor(hex: dark))
    }

    /// rgba pairs: `Color(lightRGBA: (0, 0, 0, 0.08), darkRGBA: (255, 255, 255, 0.1))`
    init(lightRGBA l: (Int, Int, Int, Double), darkRGBA d: (Int, Int, Int, Double)) {
        self.init(
            light: UIColor(red: CGFloat(l.0) / 255, green: CGFloat(l.1) / 255, blue: CGFloat(l.2) / 255, alpha: l.3),
            dark: UIColor(red: CGFloat(d.0) / 255, green: CGFloat(d.1) / 255, blue: CGFloat(d.2) / 255, alpha: d.3)
        )
    }
}

// MARK: - Colour tokens

enum Ob {
    // surfaces: pure
    static let bg = Color(light: 0xFFFFFF, dark: 0x000000)
    /// popover / dialog / panel content
    static let surface = bg
    /// hover · muted fill
    static let surface2 = Color(lightRGBA: (0, 0, 0, 0.045), darkRGBA: (255, 255, 255, 0.075))
    /// pressed · selected row
    static let surface3 = Color(lightRGBA: (0, 0, 0, 0.075), darkRGBA: (255, 255, 255, 0.12))
    /// board columns, wells, callouts
    static let tint = Color(lightRGBA: (0, 0, 0, 0.025), darkRGBA: (255, 255, 255, 0.04))
    static let overlay = Color(lightRGBA: (0, 0, 0, 0.36), darkRGBA: (0, 0, 0, 0.7))

    // lines
    static let border = Color(lightRGBA: (0, 0, 0, 0.08), darkRGBA: (255, 255, 255, 0.1))
    static let borderStrong = Color(lightRGBA: (0, 0, 0, 0.14), darkRGBA: (255, 255, 255, 0.18))
    static let input = Color(lightRGBA: (0, 0, 0, 0.13), darkRGBA: (255, 255, 255, 0.16))

    // text: neutral (text3 stays >= 4.5:1 on its base)
    static let text = Color(light: 0x0D0D0D, dark: 0xF3F3F3)
    static let text2 = Color(light: 0x4F4F4F, dark: 0xB4B4B4)
    static let text3 = Color(light: 0x767676, dark: 0x8C8C8C)
    /// placeholders / disabled only
    static let text4 = Color(light: 0xC2C2C2, dark: 0x404040)

    // primary: monochrome
    static let primary = Color(light: 0x0D0D0D, dark: 0xF3F3F3)
    static let primaryHover = Color(light: 0x333333, dark: 0xD4D4D4)
    static let onPrimary = Color(light: 0xFFFFFF, dark: 0x000000)
    static let accentSoft = Color(lightRGBA: (0, 0, 0, 0.05), darkRGBA: (255, 255, 255, 0.08))

    // semantic
    static let info = Color(light: 0x2563EB, dark: 0x60A5FA)
    static let infoText = Color(light: 0x1D4ED8, dark: 0x93C5FD)
    static let infoSoft = Color(lightRGBA: (37, 99, 235, 0.07), darkRGBA: (96, 165, 250, 0.1))
    static let danger = Color(light: 0xDC2626, dark: 0xF87171)
    static let dangerText = Color(light: 0xC42020, dark: 0xFCA5A5)
    static let dangerSoft = Color(lightRGBA: (220, 38, 38, 0.06), darkRGBA: (248, 113, 113, 0.1))
    static let dangerSolid = Color(light: 0xDC2626, dark: 0xDC2626)
    static let warn = Color(light: 0xC2410C, dark: 0xFB923C)
    static let warnText = Color(light: 0xB23A0A, dark: 0xFDBA74)
    static let warnSoft = Color(lightRGBA: (194, 65, 12, 0.06), darkRGBA: (251, 146, 60, 0.09))
    static let ok = Color(light: 0x15803D, dark: 0x4ADE80)
    static let okText = Color(light: 0x166534, dark: 0x86EFAC)
    static let okSoft = Color(lightRGBA: (21, 128, 61, 0.06), darkRGBA: (74, 222, 128, 0.08))

    static let selection = Color(lightRGBA: (37, 99, 235, 0.16), darkRGBA: (96, 165, 250, 0.3))
}

// MARK: - Semantic tones

enum Tone: String, Codable, CaseIterable {
    case neutral, danger, warn, ok, info

    var ink: Color {
        switch self {
        case .neutral: Ob.text2
        case .danger: Ob.danger
        case .warn: Ob.warn
        case .ok: Ob.ok
        case .info: Ob.info
        }
    }

    var text: Color {
        switch self {
        case .neutral: Ob.text2
        case .danger: Ob.dangerText
        case .warn: Ob.warnText
        case .ok: Ob.okText
        case .info: Ob.infoText
        }
    }

    var soft: Color {
        switch self {
        case .neutral: Ob.tint
        case .danger: Ob.dangerSoft
        case .warn: Ob.warnSoft
        case .ok: Ob.okSoft
        case .info: Ob.infoSoft
        }
    }
}

// MARK: - Project colours (ink · tag background · tag text · faint block tint)

struct ProjectPalette {
    let ink: Color
    let bg: Color
    let text: Color
    let soft: Color
}

extension ProjectColor {
    var palette: ProjectPalette {
        switch self {
        case .slate:
            ProjectPalette(ink: Color(light: 0x71717A, dark: 0xA1A1AA),
                           bg: Color(lightRGBA: (113, 113, 122, 0.1), darkRGBA: (161, 161, 170, 0.14)),
                           text: Color(light: 0x3F3F46, dark: 0xD4D4D8), soft: Ob.tint)
        case .red:
            ProjectPalette(ink: Color(light: 0xDC2626, dark: 0xF87171),
                           bg: Color(lightRGBA: (220, 38, 38, 0.08), darkRGBA: (248, 113, 113, 0.14)),
                           text: Color(light: 0xB91C1C, dark: 0xFCA5A5), soft: Ob.dangerSoft)
        case .orange:
            ProjectPalette(ink: Color(light: 0xEA580C, dark: 0xFB923C),
                           bg: Color(lightRGBA: (234, 88, 12, 0.08), darkRGBA: (251, 146, 60, 0.14)),
                           text: Color(light: 0xC2410C, dark: 0xFDBA74),
                           soft: Color(lightRGBA: (234, 88, 12, 0.06), darkRGBA: (251, 146, 60, 0.08)))
        case .amber:
            ProjectPalette(ink: Color(light: 0xCA8A04, dark: 0xFACC15),
                           bg: Color(lightRGBA: (202, 138, 4, 0.1), darkRGBA: (250, 204, 21, 0.12)),
                           text: Color(light: 0xA16207, dark: 0xFDE047),
                           soft: Color(lightRGBA: (202, 138, 4, 0.07), darkRGBA: (250, 204, 21, 0.08)))
        case .green:
            ProjectPalette(ink: Color(light: 0x16A34A, dark: 0x4ADE80),
                           bg: Color(lightRGBA: (22, 163, 74, 0.08), darkRGBA: (74, 222, 128, 0.12)),
                           text: Color(light: 0x15803D, dark: 0x86EFAC), soft: Ob.okSoft)
        case .teal:
            ProjectPalette(ink: Color(light: 0x0D9488, dark: 0x2DD4BF),
                           bg: Color(lightRGBA: (13, 148, 136, 0.08), darkRGBA: (45, 212, 191, 0.12)),
                           text: Color(light: 0x0F766E, dark: 0x5EEAD4),
                           soft: Color(lightRGBA: (13, 148, 136, 0.06), darkRGBA: (45, 212, 191, 0.08)))
        case .blue:
            ProjectPalette(ink: Color(light: 0x2563EB, dark: 0x60A5FA),
                           bg: Color(lightRGBA: (37, 99, 235, 0.08), darkRGBA: (96, 165, 250, 0.14)),
                           text: Color(light: 0x1D4ED8, dark: 0x93C5FD), soft: Ob.infoSoft)
        case .indigo:
            ProjectPalette(ink: Color(light: 0x4F46E5, dark: 0x818CF8),
                           bg: Color(lightRGBA: (79, 70, 229, 0.08), darkRGBA: (129, 140, 248, 0.15)),
                           text: Color(light: 0x4338CA, dark: 0xA5B4FC),
                           soft: Color(lightRGBA: (79, 70, 229, 0.06), darkRGBA: (129, 140, 248, 0.08)))
        case .violet:
            ProjectPalette(ink: Color(light: 0x7C3AED, dark: 0xA78BFA),
                           bg: Color(lightRGBA: (124, 58, 237, 0.08), darkRGBA: (167, 139, 250, 0.15)),
                           text: Color(light: 0x6D28D9, dark: 0xC4B5FD),
                           soft: Color(lightRGBA: (124, 58, 237, 0.06), darkRGBA: (167, 139, 250, 0.08)))
        case .pink:
            ProjectPalette(ink: Color(light: 0xDB2777, dark: 0xF472B6),
                           bg: Color(lightRGBA: (219, 39, 119, 0.08), darkRGBA: (244, 114, 182, 0.14)),
                           text: Color(light: 0xBE185D, dark: 0xF9A8D4),
                           soft: Color(lightRGBA: (219, 39, 119, 0.06), darkRGBA: (244, 114, 182, 0.08)))
        }
    }
}

// MARK: - Type scale

/*
 Web px → iOS text style. The web's 14px base reads like iOS 17pt body on a phone, so the scale is
 shifted to the platform's own sizes and follows Dynamic Type. Weights stay 400 / 500 / 600.

   web 2xs 11 → caption2      web base 14 → body (17)        web 2xl 20 → title3 (20)
   web xs 12  → caption (12)  web md 15  → body semibold     web 3xl 24 → title2 (22)
   web sm 13  → footnote (13) web lg 16  → callout (16)      web display 28 → largeTitle (34) / title (28)
   web       → subheadline 15 for secondary rows             web xl 18 → headline-ish title3
 */
enum ObFont {
    /// 12, counts, kbd-like hints
    static let micro = Font.caption2
    /// meta, captions, tags
    static let caption = Font.caption
    /// secondary UI, dense meta
    static let footnote = Font.footnote
    /// secondary rows, subtitles
    static let sub = Font.subheadline
    /// body, task titles, controls, sidebar rows
    static let body = Font.body
    /// emphasised line, card / block titles
    static let bodyStrong = Font.body.weight(.semibold)
    static let callout = Font.callout
    /// dialog titles, workspace title
    static let title3 = Font.title3.weight(.semibold)
    /// page sections
    static let title2 = Font.title2.weight(.semibold)
    /// page title
    static let title = Font.title.weight(.semibold)
    /// figures (numbers on dashboards): tabular digits
    static let figure = Font.title2.weight(.semibold).monospacedDigit()
    static let mono = Font.system(.footnote, design: .monospaced)
}

// MARK: - Shape, size, spacing

enum ObRadius {
    /// tags, kbd
    static let xs: CGFloat = 6
    /// small controls
    static let sm: CGFloat = 8
    /// rows, inputs, menu items
    static let md: CGFloat = 10
    /// cards, popovers
    static let lg: CGFloat = 16
    /// dialogs, sheets
    static let xl: CGFloat = 20
}

enum ObSize {
    /// minimum touch target / standard row
    static let row: CGFloat = 44
    static let controlSm: CGFloat = 32
    static let control: CGFloat = 40
    static let controlLg: CGFloat = 48
    static let topBar: CGFloat = 52
    /// floating glass buttons in the top bar
    static let glassButton: CGFloat = 44
    static let sidebarWidth: CGFloat = 300
}

/// 2pt grid below 16, 4pt grid from 16 up.
enum ObSpace {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
    /// page side padding on phones (web --page-pad at <=640px)
    static let page: CGFloat = 16
}

// MARK: - Motion: calm, no overshoot (no springs, bounces, count-ups or loops)

enum ObMotion {
    /// hover, press, colour (web --dur-fast 0.12s, --ease)
    static let fast = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.12)
    /// menus, toggles, small moves (--dur 0.18s)
    static let standard = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.18)
    /// panels, layout shifts (--dur-mid 0.26s)
    static let mid = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.26)
    /// page entrance (--dur-slow 0.36s, --ease-out)
    static let slow = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.36)
    /// entrances (--ease-out)
    static let enter = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.26)
}

// MARK: - Theme preference (라이트 · 다크 · 시스템)

enum ThemePref: String, CaseIterable, Identifiable, Codable {
    case light, dark, system
    var id: String { rawValue }

    var label: String {
        switch self {
        case .light: "라이트"
        case .dark: "다크"
        case .system: "시스템"
        }
    }

    var symbol: String {
        switch self {
        case .light: "sun.max"
        case .dark: "moon"
        case .system: "circle.lefthalf.filled"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: .light
        case .dark: .dark
        case .system: nil
        }
    }
}
