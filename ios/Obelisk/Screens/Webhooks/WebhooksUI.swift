import SwiftUI
import UIKit

// Small views shared by the 웹훅 screens.

// MARK: - list chrome

extension View {
    /// A row on a 웹훅 list: pure base, hairline separators, page padding.
    func webhooksRow() -> some View {
        self
            .listRowInsets(EdgeInsets(top: ObSpace.md, leading: ObSpace.page, bottom: ObSpace.md, trailing: ObSpace.page))
            .listRowBackground(Ob.bg)
            .listRowSeparatorTint(Ob.border)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    /// A plain, pure 웹훅 list.
    func webhooksList() -> some View {
        self
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Ob.bg)
            .environment(\.defaultMinListRowHeight, ObSize.row)
    }
}

/// Section head as the web's SettingsSection: title, muted lead, an action on the right.
struct WebhooksSectionHead<Action: View>: View {
    var title: String
    var lead: String?
    @ViewBuilder var action: () -> Action

    init(_ title: String, lead: String? = nil, @ViewBuilder action: @escaping () -> Action = { EmptyView() }) {
        self.title = title
        self.lead = lead
        self.action = action
    }

    var body: some View {
        HStack(alignment: .top, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                Text(title)
                    .font(ObFont.bodyStrong)
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                if let lead {
                    Text(lead)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            action()
        }
        .textCase(nil)
        .padding(.top, ObSpace.lg)
        .padding(.bottom, ObSpace.xs)
    }
}

/// Icon + text for a pill button (tighter than `Label`).
struct WebhooksButtonLabel: View {
    var text: String
    var symbol: String
    init(_ text: String, symbol: String) {
        self.text = text
        self.symbol = symbol
    }
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .accessibilityHidden(true)
            Text(text)
        }
    }
}

/// Bordered text field like `ObFieldStyle`, optionally monospaced (URLs).
struct WebhooksFieldStyle: TextFieldStyle {
    var focused = false
    var mono = false
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(mono ? .system(.callout, design: .monospaced) : ObFont.body)
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.controlLg)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(focused ? Ob.text3 : Ob.input, lineWidth: 1)
            )
    }
}

/// Small muted label above a field or body (web ui.label / .bodyLabel).
struct WebhooksFieldLabel: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(ObFont.footnote.weight(.semibold))
            .foregroundStyle(Ob.text)
    }
}

/// Muted help under a field (web ui.help).
struct WebhooksHelp: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// An icon + text meta item (web .metaItem).
struct WebhooksMeta: View {
    var symbol: String?
    var text: String
    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
                    .imageScale(.small)
                    .foregroundStyle(Ob.text3)
                    .accessibilityHidden(true)
            }
            Text(text)
                .foregroundStyle(Ob.text2)
        }
        .font(ObFont.caption)
    }
}

/// A warn / danger line under a row (web .warnLine / .errorLine).
struct WebhooksAlertLine: View {
    var tone: Tone
    var symbol: String
    var text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .imageScale(.small)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(ObFont.caption)
        .foregroundStyle(tone.text)
    }
}

/// Status text: label in its tone (danger/warn only, like the web), detail muted.
struct WebhooksStatusText: View {
    var status: WebhooksStatus
    var body: some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(status.label)
                .font(ObFont.footnote.weight(.medium))
                .foregroundStyle(status.tone == .danger || status.tone == .warn ? status.tone.text : Ob.text2)
            if let d = status.detail {
                Text(d)
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
            }
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// Delivery status chip: icon + 성공 / 실패 / 재시도 대기, ok / danger tones.
struct WebhooksStatusChip: View {
    var status: WebhookDeliveryStatus
    var body: some View {
        Chip(text: status.webhooksLabel, symbol: status.webhooksSymbol, tone: status.webhooksTone, filled: true)
    }
}

/// The web's switch (ui.switch): monochrome track, knob in the opposite ink when on, so it reads in
/// dark mode too (the system switch puts a white knob on a near-white track there).
/// Now the app-wide switch (Components/UIKit.swift `ObSwitchStyle`); kept so call sites read the same.
typealias WebhooksSwitchStyle = ObSwitchStyle

/// The web's custom check box (pick rows): hairline square, filled with a check when on.
struct WebhooksCheckbox: View {
    var on: Bool
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(on ? Ob.primary : Ob.bg)
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(on ? Ob.primary : Ob.input, lineWidth: 1.5)
            if on {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Ob.onPrimary)
            }
        }
        .frame(width: 20, height: 20)
        .animation(ObMotion.fast, value: on)
        .accessibilityHidden(true)
    }
}

// MARK: - copying

@MainActor
func webhooksCopy(_ text: String, _ done: String, toasts: Toasts) {
    UIPasteboard.general.string = text
    Haptics.success()
    toasts.show(done)
}

/// Read-only value + 복사 / 공유 (web CopyField). The value is selectable too.
struct WebhooksCopyField: View {
    var value: String
    /// VoiceOver name of the value ("서명 키").
    var label: String
    /// Toast after copying ("서명 키를 복사했어요").
    var done: String

    @Environment(Toasts.self) private var toasts
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text(value)
                .font(ObFont.mono)
                .foregroundStyle(Ob.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, ObSpace.md)
                .padding(.vertical, ObSpace.md)
                .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
                .accessibilityLabel(label)
                .accessibilityValue(value)
            HStack(spacing: ObSpace.sm) {
                Button {
                    webhooksCopy(value, done, toasts: toasts)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.6))
                        copied = false
                    }
                } label: {
                    WebhooksButtonLabel(copied ? "복사됨" : "복사", symbol: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.ob(.outline, size: .small))
                ShareLink(item: value) {
                    WebhooksButtonLabel("공유", symbol: "square.and.arrow.up")
                }
                .buttonStyle(.ob(.outline, size: .small))
            }
        }
    }
}

/// Copyable code block (web Code): monospaced, scrolls sideways, copy button in the corner.
struct WebhooksCodeBlock: View {
    var code: String
    /// Wrap long lines (bodies) instead of scrolling sideways (code).
    var wrap = false

    @Environment(Toasts.self) private var toasts

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if wrap {
                    text.frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) { text }
                }
            }
            .padding(.vertical, 10)
            .padding(.leading, ObSpace.md)
            .padding(.trailing, 44)
            Button {
                webhooksCopy(code, "복사했어요", toasts: toasts)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 14))
                    .foregroundStyle(Ob.text2)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("복사")
        }
        .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.md))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.border, lineWidth: 1))
        .contextMenu {
            Button {
                webhooksCopy(code, "복사했어요", toasts: toasts)
            } label: {
                Label("복사", systemImage: "doc.on.doc")
            }
        }
    }

    private var text: some View {
        Text(code)
            .font(.system(.caption, design: .monospaced))
            .lineSpacing(3)
            .foregroundStyle(Ob.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: !wrap, vertical: true)
    }
}

// MARK: - inline code in help text

/// Text with `code` spans in monospace and full ink, the rest muted (web <code> in help copy).
func webhooksRich(_ source: String, base: Color = Ob.text2) -> AttributedString {
    var opts = AttributedString.MarkdownParsingOptions()
    opts.interpretedSyntax = .inlineOnlyPreservingWhitespace
    var s = (try? AttributedString(markdown: source, options: opts)) ?? AttributedString(source)
    s.foregroundColor = base
    for run in s.runs where run.inlinePresentationIntent?.contains(.code) == true {
        s[run.range].foregroundColor = Ob.text
        s[run.range].font = .system(.footnote, design: .monospaced)
    }
    return s
}

// MARK: - sheets and confirmations, per screen

/// Presents a screen's 웹훅 sheets (forms, reveals). Reloads when one closes, so a URL or secret that
/// was tried right away shows what came in.
struct WebhooksActionHost: ViewModifier {
    var model: WebhooksModel
    @Binding var sheet: WebhooksSheet?

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    func body(content: Content) -> some View {
        content
            .sheet(item: $sheet, onDismiss: { Task { await model.load() } }) { s in
                WebhooksSheetView(model: model, sheet: s)
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(ObRadius.xl + 8)
                    .presentationBackground(Ob.bg)
                    .overlay(alignment: .bottom) { ToastOverlay(raised: true) }
                    .environment(store)
                    .environment(router)
                    .environment(store.toasts)
            }
    }
}

/// The delete / rotate confirmation, anchored to the row or button that asked for it (iOS 26 shows it
/// as a popover from there). Runs what was confirmed; a rotation opens the reveal sheet.
struct WebhooksConfirmAnchor: ViewModifier {
    var model: WebhooksModel
    @Binding var confirm: WebhooksConfirm?
    @Binding var sheet: WebhooksSheet?
    /// Which confirmations this anchor presents.
    var matches: (WebhooksConfirm) -> Bool
    /// After a delete went through (a detail screen pops itself).
    var onDeleted: () -> Void = {}

    func body(content: Content) -> some View {
        let mine = confirm.flatMap { matches($0) ? $0 : nil }
        content.confirmationDialog(
            mine?.title ?? "",
            isPresented: Binding(get: { mine != nil }, set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible,
            presenting: mine
        ) { c in
            Button(c.actionLabel, role: .destructive) {
                Task {
                    let r = await model.run(c)
                    if let reveal = r.reveal { sheet = .reveal(reveal) }
                    if r.ok, c.isDelete { onDeleted() }
                }
            }
            Button("취소", role: .cancel) {}
        } message: { c in
            Text(c.message)
        }
    }
}

extension View {
    /// Present the confirmations for one webhook (`hookId`) from this view.
    func webhooksConfirm(
        _ model: WebhooksModel, _ confirm: Binding<WebhooksConfirm?>, sheet: Binding<WebhooksSheet?>,
        hook hookId: String, onDeleted: @escaping () -> Void = {}
    ) -> some View {
        modifier(WebhooksConfirmAnchor(model: model, confirm: confirm, sheet: sheet, matches: { $0.hookId == hookId }, onDeleted: onDeleted))
    }

    /// Present one kind of confirmation from this view (a detail screen's own button).
    func webhooksConfirm(
        _ model: WebhooksModel, _ confirm: Binding<WebhooksConfirm?>, sheet: Binding<WebhooksSheet?>,
        when matches: @escaping (WebhooksConfirm) -> Bool, onDeleted: @escaping () -> Void = {}
    ) -> some View {
        modifier(WebhooksConfirmAnchor(model: model, confirm: confirm, sheet: sheet, matches: matches, onDeleted: onDeleted))
    }
}

/// The content of a 웹훅 sheet.
struct WebhooksSheetView: View {
    var model: WebhooksModel
    var sheet: WebhooksSheet

    var body: some View {
        switch sheet {
        case let .outgoingForm(h):
            WebhooksOutgoingForm(model: model, initial: h)
        case let .incomingForm(h):
            WebhooksIncomingForm(model: model, initial: h)
        case let .reveal(r):
            WebhooksRevealSheet(model: model, item: r)
        }
    }
}
