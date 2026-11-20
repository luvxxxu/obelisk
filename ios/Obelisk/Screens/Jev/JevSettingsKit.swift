import SwiftUI
import UIKit

// Building blocks for the 설정 › Jev and 설정 › AI 연결 pages (web settings SettingsSection / SettingsRow,
// components/Copy.tsx). No cards: sections sit on the pure page, rows are separated by hairlines.

/// A settings section: semibold title (+ a status chip), muted lead, then rows or free content.
struct JevSettingsSection<Actions: View, Content: View>: View {
    var title: String
    var badge: (text: String, tone: Tone)?
    var lead: String?
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    init(
        _ title: String,
        badge: (text: String, tone: Tone)? = nil,
        lead: String? = nil,
        @ViewBuilder actions: @escaping () -> Actions = { EmptyView() },
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.badge = badge
        self.lead = lead
        self.actions = actions
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                HStack(spacing: ObSpace.sm) {
                    Text(title)
                        .font(ObFont.bodyStrong)
                        .foregroundStyle(Ob.text)
                        .accessibilityAddTraits(.isHeader)
                    if let badge {
                        Chip(text: badge.text, tone: badge.tone, filled: true)
                    }
                }
                if let lead {
                    Text(lead)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if Actions.self != EmptyView.self {
                    FlowRow(spacing: ObSpace.sm, lineSpacing: ObSpace.sm) { actions() }
                        .padding(.top, ObSpace.sm)
                }
            }
            .padding(.bottom, ObSpace.md)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row under a section: hairline above, title + description, control on the right or below.
struct JevSettingsRow<Description: View, Control: View>: View {
    var title: String
    var stacked = false
    @ViewBuilder var description: () -> Description
    @ViewBuilder var control: () -> Control

    init(_ title: String, stacked: Bool = false, @ViewBuilder description: @escaping () -> Description, @ViewBuilder control: @escaping () -> Control) {
        self.title = title
        self.stacked = stacked
        self.description = description
        self.control = control
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline()
            Group {
                if stacked {
                    VStack(alignment: .leading, spacing: ObSpace.md) {
                        labels
                        control()
                    }
                } else {
                    HStack(alignment: .center, spacing: ObSpace.lg) {
                        labels
                        Spacer(minLength: 0)
                        control()
                    }
                }
            }
            .padding(.vertical, 14)
        }
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(ObFont.body.weight(.medium))
                .foregroundStyle(Ob.text)
            description()
                .font(ObFont.footnote)
                .foregroundStyle(Ob.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Markdown-lite copy (bold, `code`, links) the way the web writes its help: strong words and code in
/// full ink, links underlined in ink, the rest in the caller's colour.
func jevRich(_ markdown: String) -> AttributedString {
    var s = (try? AttributedString(
        markdown: markdown,
        options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(markdown)
    var links: [Range<AttributedString.Index>] = []
    var inked: [Range<AttributedString.Index>] = []
    for run in s.runs {
        if run.link != nil { links.append(run.range) }
        if let intent = run.inlinePresentationIntent, intent.contains(.stronglyEmphasized) || intent.contains(.code) {
            inked.append(run.range)
        }
    }
    for r in links {
        s[r].underlineStyle = .single
        s[r].foregroundColor = Ob.text
    }
    for r in inked { s[r].foregroundColor = Ob.text }
    return s
}

/// Copy to the clipboard and say so (web copyText).
@MainActor
func jevCopy(_ text: String, _ toasts: Toasts, done: String = "복사했어요") {
    UIPasteboard.general.string = text
    Haptics.success()
    toasts.show(done)
}

/// Read-only value + copy button (web CopyField).
struct JevCopyField: View {
    var value: String
    var label: String
    var done: String
    /// Show the whole value on up to three lines (a secret shown once) instead of truncating it.
    var wraps = false
    @Environment(Toasts.self) private var toasts
    @State private var copied = false

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            Text(value)
                .font(ObFont.mono)
                .foregroundStyle(Ob.text)
                .lineLimit(wraps ? 3 : 1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .padding(.horizontal, ObSpace.md)
                .padding(.vertical, wraps ? ObSpace.sm : 0)
                .frame(maxWidth: .infinity, minHeight: ObSize.controlLg, alignment: .leading)
                .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
                .accessibilityLabel(label)
                .accessibilityValue(value)
            Button {
                jevCopy(value, toasts, done: done)
                withAnimation(ObMotion.fast) { copied = true }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                    Text(copied ? "복사됨" : "복사")
                }
            }
            .buttonStyle(.ob(.outline, size: .large))
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(1.6))
                withAnimation(ObMotion.fast) { copied = false }
            }
        }
    }
}

/// Copyable code block (shell command / config), scrolling sideways instead of wrapping.
struct JevCodeBlock: View {
    var code: String
    @Environment(Toasts.self) private var toasts
    @State private var copied = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(ObFont.mono)
                    .foregroundStyle(Ob.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.vertical, ObSpace.md)
                    .padding(.horizontal, ObSpace.md)
            }
            Button {
                jevCopy(code, toasts)
                withAnimation(ObMotion.fast) { copied = true }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Ob.text2)
                    .frame(width: ObSize.row, height: ObSize.row)
                    .contentShape(Rectangle())
            }
            .buttonStyle(JevPressStyle())
            .accessibilityLabel("복사")
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(1.6))
                withAnimation(ObMotion.fast) { copied = false }
            }
        }
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.md))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.border, lineWidth: 1))
    }
}

/// Labelled field (web ui.field: label above, help below).
struct JevField<Field: View>: View {
    var label: String
    var note: String?
    var help: String?
    var helpTone: Tone = .neutral
    @ViewBuilder var field: () -> Field

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(Text(label).foregroundStyle(Ob.text))\(Text(note.map { " · \($0)" } ?? "").foregroundStyle(Ob.text3).fontWeight(.regular))")
                .font(ObFont.footnote.weight(.medium))
            field()
            if let help {
                Text(help)
                    .font(ObFont.caption)
                    .foregroundStyle(helpTone == .neutral ? Ob.text3 : helpTone.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The kit's bordered field with monospaced text, for URLs, ids and model names (web `.mono` inputs).
struct JevMonoFieldStyle: TextFieldStyle {
    var focused = false
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(.callout, design: .monospaced))
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.controlLg)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(focused ? Ob.text3 : Ob.input, lineWidth: 1)
            )
    }
}
