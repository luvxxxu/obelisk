import SwiftUI
import UIKit

// Small pieces shared by the organization screens and 설정 › 일반: the web's SettingsSection /
// SettingsRow look (a heading with a muted lead, then a hairline card of rows), workspace marks,
// labels and the date formats the web prints with toLocaleDateString('ko-KR').

// MARK: - Labels

/// web `workspaceLabel`: a personal space always reads "개인 공간".
func orgWorkspaceLabel(_ w: WorkspaceSummary?) -> String {
    guard let w else { return "Obelisk" }
    return w.kind == .personal ? "개인 공간" : w.name
}

/// web `ROLE_HINT` (org settings role menu).
func orgRoleHint(_ r: WorkspaceRole) -> String {
    switch r {
    case .owner: "모든 권한 · 조직 삭제"
    case .admin: "멤버·팀·모든 프로젝트 관리"
    case .member: "공유받은 프로젝트만"
    }
}

/// web `LEVEL_LABEL_KO` for a raw level ("none" | "view" | "edit" | "manage").
func orgLevelLabel(_ raw: String) -> String {
    switch raw {
    case "none": "권한 없음"
    case "view": "보기"
    case "edit": "쓰기"
    case "manage": "관리"
    default: raw
    }
}

extension Notification.Name {
    /// An invite link was made somewhere (the invite sheet): the org settings list reloads.
    static let orgInvitesChanged = Notification.Name("obelisk.org.invitesChanged")
}

// MARK: - Dates (web toLocaleDateString / toLocaleTimeString with ko-KR, in the user's zone)

enum OrgDates {
    static func calendar(_ timezone: String) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: timezone) ?? .current
        return cal
    }

    /// "11월 26일"
    static func monthDay(_ iso: String, _ timezone: String) -> String {
        guard let d = ISO8601DateFormatter.parse(iso) else { return "" }
        let c = calendar(timezone).dateComponents([.month, .day], from: d)
        return "\(c.month ?? 1)월 \(c.day ?? 1)일"
    }

    /// "11월 19일 (수)"
    static func dayLabel(_ iso: String, _ timezone: String) -> String {
        guard let d = ISO8601DateFormatter.parse(iso) else { return "" }
        let c = calendar(timezone).dateComponents([.month, .day, .weekday], from: d)
        let wd = WEEKDAYS_KO[((c.weekday ?? 1) - 1 + 7) % 7]
        return "\(c.month ?? 1)월 \(c.day ?? 1)일 (\(wd))"
    }

    /// "오후 03:12" (web hour: '2-digit', minute: '2-digit')
    static func time(_ iso: String, _ timezone: String) -> String {
        guard let d = ISO8601DateFormatter.parse(iso) else { return "" }
        let c = calendar(timezone).dateComponents([.hour, .minute], from: d)
        let h = c.hour ?? 0
        let h12 = h % 12 == 0 ? 12 : h % 12
        return String(format: "%@ %02d:%02d", h < 12 ? "오전" : "오후", h12, c.minute ?? 0)
    }
}

// MARK: - Section + card

/// web SettingsSection: a heading (with an optional action on the right) and a muted lead, then content.
struct OrgSection<Action: View, Content: View>: View {
    var title: String
    var lead: String?
    @ViewBuilder var action: () -> Action
    @ViewBuilder var content: () -> Content

    init(_ title: String, lead: String? = nil, @ViewBuilder action: @escaping () -> Action, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.lead = lead
        self.action = action
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: ObSpace.xs) {
                HStack(alignment: .center, spacing: ObSpace.md) {
                    Text(title)
                        .font(ObFont.callout.weight(.semibold))
                        .foregroundStyle(Ob.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    action()
                }
                if let lead {
                    Text(lead)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, ObSpace.xs)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension OrgSection where Action == EmptyView {
    init(_ title: String, lead: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(title, lead: lead, action: { EmptyView() }, content: content)
    }
}

/// A resting card of rows: pure base, hairline border, hairlines between rows (inset like a list).
struct OrgCard<Content: View>: View {
    /// Leading inset of the hairline between rows.
    var inset: CGFloat = ObSpace.lg
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { subviews in
                ForEach(subviews) { sub in
                    if sub.id != subviews.first?.id {
                        Hairline().padding(.leading, inset)
                    }
                    sub
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.lg))
        .clipShape(RoundedRectangle(cornerRadius: ObRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
    }
}

extension View {
    /// Padding and minimum height for one row inside an OrgCard.
    func orgRow(vertical: CGFloat = ObSpace.md) -> some View {
        self
            .padding(.horizontal, ObSpace.lg)
            .padding(.vertical, vertical)
            .frame(maxWidth: .infinity, minHeight: ObSize.row, alignment: .leading)
    }
}

/// The muted line inside a card when a list is empty (web settings .empty).
struct OrgEmptyRow: View {
    var text: String
    var body: some View {
        Text(text)
            .font(ObFont.sub)
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
            .orgRow(vertical: ObSpace.lg)
    }
}

/// web settings footer: "저장하지 않은 변경 사항이 있어요" + 저장.
struct OrgSaveFooter: View {
    var dirty: Bool
    var canSave: Bool
    var busy = false
    var save: () -> Void

    var body: some View {
        HStack(spacing: ObSpace.md) {
            Text(dirty ? "저장하지 않은 변경 사항이 있어요" : "바꾸면 저장 버튼이 켜져요")
                .font(ObFont.footnote)
                .foregroundStyle(dirty ? Ob.text2 : Ob.text3)
                .animation(ObMotion.fast, value: dirty)
            Spacer(minLength: ObSpace.sm)
            Button(action: save) {
                ZStack {
                    Text("저장").opacity(busy ? 0 : 1)
                    if busy { ProgressView().controlSize(.small).tint(Ob.onPrimary) }
                }
            }
            .buttonStyle(.ob(.primary, size: .small))
            .disabled(!canSave || busy)
        }
        .orgRow()
    }
}

/// Bordered search field (web .search): magnifier + text, radius 10.
struct OrgSearchField: View {
    var prompt: String
    @Binding var text: String
    var label: String?

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
            TextField(prompt, text: $text)
                .font(ObFont.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(label ?? prompt)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Ob.text4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("지우기")
            }
        }
        .padding(.horizontal, ObSpace.md)
        .frame(minHeight: ObSize.control)
        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.input, lineWidth: 1))
    }
}

/// web WorkspaceMark: personal space = filled disc with the Obelisk mark; organization = outlined disc
/// with its initial (it reads as "shared").
struct OrgSpaceMark: View {
    var kind: WorkspaceKind
    var name: String
    var size: CGFloat = 28

    var body: some View {
        Group {
            if kind == .org {
                Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased().orgIfEmpty("?"))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Ob.text)
                    .frame(width: size, height: size)
                    .overlay(Circle().strokeBorder(Ob.borderStrong, lineWidth: 1.5))
            } else {
                Image("Logo")
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .frame(width: size * 0.5, height: size * 0.5)
                    .foregroundStyle(Ob.bg)
                    .frame(width: size, height: size)
                    .background(Ob.text, in: Circle())
            }
        }
        .accessibilityHidden(true)
    }
}

/// Team mark (web .teamMark): people glyph in a quiet disc, the size of a small avatar.
struct OrgTeamMark: View {
    var size: CGFloat = 32
    var body: some View {
        Image(systemName: "person.2")
            .font(.system(size: size * 0.4, weight: .medium))
            .foregroundStyle(Ob.text2)
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(Ob.borderStrong, lineWidth: 1))
            .accessibilityHidden(true)
    }
}

/// A radio row (workspace pickers): mark, name, meta, a check when chosen.
struct OrgSpaceOption: View {
    var space: WorkspaceSummary
    var meta: String
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: ObSpace.md) {
                OrgSpaceMark(kind: space.kind, name: space.name, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(orgWorkspaceLabel(space))
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Text(meta)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .lineLimit(1)
                }
                Spacer(minLength: ObSpace.sm)
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Ob.text)
                    .opacity(selected ? 1 : 0)
            }
            .orgRow(vertical: 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(OrgPressStyle())
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// A full-width press highlight for rows inside an OrgCard.
struct OrgPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Ob.surface2 : Color.clear)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

/// A "·" bullet list of plain notes (web ul.notes / ul.facts).
struct OrgNotes: View {
    var lines: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            ForEach(lines, id: \.self) { line in
                HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                    Text("·").foregroundStyle(Ob.text3)
                    Text(line)
                        .foregroundStyle(Ob.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(ObFont.footnote)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Sheet heading in content (title + muted description), like the web's Modal header.
struct OrgSheetHeader: View {
    var title: String
    var description: String?
    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.xs) {
            Text(title)
                .font(ObFont.title3)
                .foregroundStyle(Ob.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let description {
                Text(description)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension String {
    fileprivate func orgIfEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

// MARK: - Clipboard

@MainActor
func orgCopy(_ text: String, toast: String, store: AppStore) {
    UIPasteboard.general.string = text
    Haptics.tap()
    store.toasts.show(toast)
}
