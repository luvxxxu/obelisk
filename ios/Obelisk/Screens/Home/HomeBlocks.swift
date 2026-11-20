import SwiftUI

// Building blocks of the home page (web _home/blocks.tsx): inline list header, board columns and cards,
// list rows, tags. Presentational only; callers pass data and actions.

/// A tag on a hue's alpha tint (web blocks `Tag`): no dot, no pill.
struct HomeTag: View {
    var text: String
    var hue: ProjectColor = .slate

    init(_ text: String, hue: ProjectColor = .slate) {
        self.text = text
        self.hue = hue
    }

    var body: some View {
        Text(text)
            .font(ObFont.caption.weight(.medium))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(hue.palette.text)
            .padding(.horizontal, 6)
            .frame(height: 20)
            .background(hue.palette.bg, in: RoundedRectangle(cornerRadius: ObRadius.xs))
    }
}

/// Inline list header (web blocks `Database`): a small title that opens its page, quiet tools and a
/// "새로 만들기" pill on the right.
struct HomeListHeader<Tools: View>: View {
    var symbol: String
    var title: String
    var page: Page?
    var pageLabel: String?
    var newLabel: String?
    var onNew: (() -> Void)?
    @ViewBuilder var tools: () -> Tools

    @Environment(Router.self) private var router

    init(
        symbol: String, title: String, page: Page? = nil, pageLabel: String? = nil,
        newLabel: String? = nil, onNew: (() -> Void)? = nil,
        @ViewBuilder tools: @escaping () -> Tools = { EmptyView() }
    ) {
        self.symbol = symbol
        self.title = title
        self.page = page
        self.pageLabel = pageLabel
        self.newLabel = newLabel
        self.onNew = onNew
        self.tools = tools
    }

    var body: some View {
        HStack(spacing: ObSpace.sm) {
            if let page {
                Button {
                    router.open(page)
                } label: {
                    titleLabel(chevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(pageLabel ?? title)
                .accessibilityHint(title)
            } else {
                titleLabel(chevron: false)
            }
            Spacer(minLength: ObSpace.sm)
            tools()
            if let onNew {
                Button(newLabel ?? "새로 만들기", action: onNew)
                    .buttonStyle(.ob(.outline, size: .small))
            }
        }
        .frame(minHeight: ObSize.row)
    }

    private func titleLabel(chevron: Bool) -> some View {
        HStack(spacing: ObSpace.sm) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(Ob.text3)
                .frame(width: 20)
            Text(title)
                .font(ObFont.body.weight(.medium))
                .foregroundStyle(Ob.text2)
                .lineLimit(1)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Ob.text4)
            }
        }
        .frame(minHeight: ObSize.row)
        .contentShape(Rectangle())
    }
}

/// A board column (web blocks `Column`): faint well, title + count, cards, footer.
struct HomeColumn<Content: View, Footer: View>: View {
    var title: String
    var count: Int
    var targeted = false
    var ghost = false
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    init(
        title: String, count: Int, targeted: Bool = false, ghost: Bool = false,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer = { EmptyView() }
    ) {
        self.title = title
        self.count = count
        self.targeted = targeted
        self.ghost = ghost
        self.content = content
        self.footer = footer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Text(title)
                    .font(ObFont.footnote.weight(.semibold))
                    .foregroundStyle(Ob.text)
                Text("\(count)")
                    .font(ObFont.footnote.monospacedDigit())
                    .foregroundStyle(Ob.text3)
                Spacer(minLength: 0)
            }
            .frame(height: 28)
            .padding(.horizontal, ObSpace.xs)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(title) \(count)개")
            .accessibilityAddTraits(.isHeader)
            content()
            footer()
        }
        .padding(ObSpace.sm)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: ObRadius.lg)
                .fill(targeted ? Ob.surface2 : (ghost ? Color.clear : Ob.tint))
        )
        .overlay {
            if targeted || ghost {
                RoundedRectangle(cornerRadius: ObRadius.lg)
                    .strokeBorder(targeted ? Ob.borderStrong : Ob.border, lineWidth: 1)
            }
        }
        .animation(ObMotion.standard, value: targeted)
    }
}

/// Quiet full-width row under a column's cards: "+ 새 작업", "외 n개 더 보기".
struct HomeColumnButton: View {
    var symbol: String?
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 13, weight: .medium)) }
                Text(label)
                Spacer(minLength: 0)
            }
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text3)
            .padding(.horizontal, ObSpace.sm)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
    }
}

/// One line of card meta (icon + text), red when overdue.
struct HomeCardMeta: View {
    var symbol: String?
    var text: String
    var tone: Tone = .neutral

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 12))
                    .foregroundStyle(tone == .neutral ? Ob.text3 : tone.text)
            }
            Text(text)
                .lineLimit(1)
        }
        .font(ObFont.caption)
        .foregroundStyle(tone == .neutral ? Ob.text2 : tone.text)
    }
}

/// Progress bar with its percentage (project cards).
struct HomeProgress: View {
    var pct: Int
    var label: String

    var body: some View {
        HStack(spacing: 10) {
            Text("\(pct)%")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.text2)
                .frame(minWidth: 34, alignment: .leading)
            HomeBar(fraction: Double(pct) / 100)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue("\(pct)%")
    }
}

/// A 4pt track with a monochrome fill.
struct HomeBar: View {
    var fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Ob.surface3)
                Capsule().fill(Ob.text)
                    .frame(width: geo.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 4)
        .animation(ObMotion.slow, value: fraction)
    }
}

/// Dashed "+ 새 일정" box for an empty list (web blocks `NewPageBox`).
struct HomeNewBox: View {
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "plus").font(.system(size: 14, weight: .medium))
                Text(label)
            }
            .font(ObFont.body)
            .foregroundStyle(Ob.text3)
            .frame(maxWidth: .infinity, minHeight: ObSize.row)
            .background(
                RoundedRectangle(cornerRadius: ObRadius.md)
                    .strokeBorder(Ob.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
            .contentShape(RoundedRectangle(cornerRadius: ObRadius.md))
        }
        .buttonStyle(.obRow)
    }
}

/// "모아보기에서 모든 공간 보기 →" style text link.
struct HomeMoreLink: View {
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(label)
                Image(systemName: "arrow.right").font(.system(size: 12, weight: .medium))
            }
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text2)
            .padding(.horizontal, ObSpace.sm)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .padding(.leading, -ObSpace.sm)
    }
}

/// A space's mark: the personal space keeps the Obelisk mark on a filled disc, an organization
/// shows its initial in an outlined one (web WorkspaceMark).
struct HomeSpaceMark: View {
    var space: WorkspaceSummary
    var size: CGFloat = 22

    var body: some View {
        Group {
            if space.kind == .org {
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(Ob.text)
                    .frame(width: size, height: size)
                    .overlay(Circle().strokeBorder(Ob.borderStrong, lineWidth: 1.5))
            } else {
                Image("Logo")
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .frame(width: size * 0.55, height: size * 0.55)
                    .foregroundStyle(Ob.bg)
                    .frame(width: size, height: size)
                    .background(Ob.text, in: Circle())
            }
        }
        .accessibilityHidden(true)
    }

    private var initial: String {
        let s = String(space.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
        return s.isEmpty ? "?" : s
    }
}

/// "개인 공간" for the personal space, the organization's name otherwise (web workspaceLabel).
func homeSpaceLabel(_ w: WorkspaceSummary?) -> String {
    guard let w else { return "Obelisk" }
    return w.kind == .personal ? "개인 공간" : w.name
}

/// Opens the new-task sheet (the web's quick add).
@MainActor
func homeNewTask(_ router: Router) {
    router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: router.newTaskPrefill) })
}
