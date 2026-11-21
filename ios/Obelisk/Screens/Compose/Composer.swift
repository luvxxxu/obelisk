import SwiftUI

/// The floating quick-add bar at the bottom of list pages: ChatGPT's composer on Liquid Glass, with the
/// web QuickAdd inside. Type "보고서 내일 오후 3시 #업무 !높음": the chips above the line show exactly what
/// will be understood (tap one to keep its words as text), Jev offers project / priority / fixed for what
/// the text leaves open, return or ↑ adds the task and keeps the keyboard up for the next one. "+" opens
/// the full form with what's typed so far. Pasting several lines offers 줄마다 작업 N개 만들기 (web ⌘V).
struct Composer: View {
    var page: Page

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var text = ""
    @State private var disabled: [QuickAddKind] = []
    @State private var busy = false
    @State private var helpOpen = false
    @State private var jev = ComposeJevState()
    /// Text pasted with several lines: kept whole for 줄마다 작업 만들기 while the field still shows it joined.
    @State private var pasted: PastedLines?
    @FocusState private var focused: Bool

    private struct PastedLines: Equatable {
        var raw: String
        var joined: String
        var count: Int
    }

    var body: some View {
        let m = model
        // The page's bottom inset rides on the keyboard, so the bar sits right above it while typing.
        VStack(spacing: ObSpace.sm) {
            GlassEffectContainer(spacing: ObSpace.sm) {
                HStack(alignment: .bottom, spacing: ObSpace.sm) {
                    plusButton(m)
                    field(m)
                }
            }
        }
        .padding(.horizontal, ObSpace.md)
        .padding(.top, ObSpace.xs)
        .padding(.bottom, ObSpace.sm)
        .animation(ObMotion.standard, value: m.chips.map(\.id))
        .animation(ObMotion.standard, value: m.offers.map(\.kind))
        .animation(ObMotion.standard, value: m.typing)
        .animation(ObMotion.mid, value: helpOpen)
        .animation(ObMotion.standard, value: pasted)
        .task(id: m.triageKey) {
            await jev.run(
                key: m.triageKey,
                title: m.title,
                startDate: m.parsed.startDate,
                dueDate: m.due,
                projectId: m.projectChosen ? .some(m.ctx.projectId.flatMap { $0 } ?? m.matched?.id) : nil,
                connected: store.user?.jev.connected ?? false,
                autoApply: store.user?.jev.autoApply ?? false
            )
        }
        .onChange(of: focused) { _, f in
            if !f, text.isEmpty { helpOpen = false }
        }
    }

    // MARK: - model (recomputed per keystroke, like the web's useMemo)

    private struct Model {
        var ctx: ComposeContext
        var parsed: QuickAddResult
        var title: String
        var matched: Project?
        var chips: [ComposeChipModel]
        var defaultChip: ComposeChipModel?
        var due: ISODate?
        var projectChosen: Bool
        var triageKey: String
        var live: TriageSuggestion?
        var jevProject: Project?
        var offers: [ComposeJevOffer]
        var typing: Bool
        var showJev: Bool
    }

    private var model: Model {
        let ctx = ComposeContext.composer(page, store)
        let parsed = parseQuickAdd(text, store.today, disabled: disabled, nowMinutes: ComposeParse.nowMinutes(store))
        let title = parsed.title.composeTrimmed
        let active = store.openProjects
        let matched = parsed.projectName.flatMap { matchProject(active, $0) }
        let due = parsed.dueDate ?? (parsed.startDate != nil ? nil : ctx.defaultDueDate)
        let projectChosen = ctx.projectId != nil || parsed.projectName != nil
        let triageKey = [title, parsed.startDate ?? "-", due ?? "-", projectChosen ? "1" : "0"].joined(separator: "|")
        let live = jev.live(triageKey, title: title)
        // A coin-flip project guess is noise: only offer one Jev is at least fairly sure about.
        var jevProject: Project?
        if let lp = live?.project, let id = lp.id, !projectChosen, lp.confidence >= 0.5 {
            jevProject = active.first { $0.id == id && store.canWriteProject($0.id) }
        }
        var offers: [ComposeJevOffer] = []
        if let live {
            if let jp = jevProject, let lp = live.project {
                offers.append(ComposeJevOffer(kind: .project, text: jp.name, confidence: lp.confidence, color: jp.color.palette.ink))
            }
            if parsed.priority == nil, live.priority.value > 0 {
                offers.append(ComposeJevOffer(kind: .priority, text: "우선순위 \(PriorityInfo.labelKo[live.priority.value] ?? "")", confidence: live.priority.confidence))
            }
            if !parsed.fixed, live.fixed.value {
                offers.append(ComposeJevOffer(kind: .fixed, text: "고정 일정", confidence: live.fixed.probability))
            }
        }
        let typing = !text.composeTrimmed.isEmpty
        let showDefault = parsed.dueDate == nil && parsed.startDate == nil && ctx.defaultDueDate != nil && typing
        let connected = store.user?.jev.connected ?? false
        return Model(
            ctx: ctx,
            parsed: parsed,
            title: title,
            matched: matched,
            chips: ComposeParse.chips(parsed, today: store.today, matched: matched),
            defaultChip: showDefault ? ComposeParse.defaultDateChip(ctx.defaultDueDate!, today: store.today) : nil,
            due: due,
            projectChosen: projectChosen,
            triageKey: triageKey,
            live: live,
            jevProject: jevProject,
            offers: offers,
            typing: typing,
            showJev: typing && (!offers.isEmpty || (jev.asking && live == nil && connected))
        )
    }

    private func take(_ k: ComposeJevKind, _ m: Model) -> Bool {
        jev.accepted.contains(k) && m.offers.contains { $0.kind == k }
    }

    // MARK: - pieces

    private func plusButton(_ m: Model) -> some View {
        Button {
            openForm(m)
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(Ob.text)
                .frame(width: ComposerMetrics.height, height: ComposerMetrics.height)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("새 작업 양식 열기")
        .accessibilityHint("날짜, 프로젝트, 담당자, 먼저 끝나야 하는 작업까지 정할 수 있어요")
    }

    private func field(_ m: Model) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if helpOpen, !m.typing {
                ScrollView {
                    ComposeSyntaxHelp(chipsAbove: true) {
                        helpOpen = false
                        focused = true
                    }
                    .padding(.horizontal, ObSpace.lg)
                    .padding(.top, ObSpace.lg)
                    .padding(.bottom, ObSpace.sm)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 280)
                .fixedSize(horizontal: false, vertical: true)
                .overlay(alignment: .bottom) { Hairline().padding(.horizontal, ObSpace.lg) }
                .transition(.opacity)
            }
            if let p = pasted, text == p.joined {
                Button {
                    Task { await makeLines(p, m) }
                } label: {
                    ListsButtonLabel(title: "줄마다 작업 \(p.count)개 만들기", symbol: "list.bullet")
                }
                .buttonStyle(.ob(.outline, size: .small))
                .disabled(busy)
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity)
                .accessibilityHint("붙여넣은 줄을 각각 작업으로 추가해요")
            }
            if !m.chips.isEmpty || m.defaultChip != nil {
                // Everything that will be understood, at a glance (wraps rather than scrolls).
                FlowRow(spacing: 6, lineSpacing: 6) {
                    ForEach(m.chips) { c in
                        ComposeChip(chip: c) {
                            Haptics.select()
                            if let k = c.kind { disabled.append(k) }
                        }
                        .transition(.opacity)
                    }
                    if let d = m.defaultChip { ComposeChip(chip: d) }
                    if !m.title.isEmpty {
                        // 약속하기 전에: when could this really be done?
                        Button {
                            openCommit(m)
                        } label: {
                            ComposeChip(chip: ComposeChipModel(id: "commit", kind: nil, symbol: "calendar.badge.checkmark", text: "가능한 날짜", tone: .dashed))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("가능한 날짜 보기")
                        .accessibilityHint("언제까지 끝낼 수 있는지 계산해요")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .transition(.opacity)
            }
            if m.showJev {
                ComposeJevRow(
                    offers: m.offers,
                    asking: jev.asking,
                    isOn: { jev.accepted.contains($0) },
                    onToggle: { jev.toggle($0) },
                    onTakeAll: { jev.accepted = Set(m.offers.map(\.kind)) }
                )
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .transition(.opacity)
            }
            HStack(alignment: .bottom, spacing: 4) {
                input(m)
                trailing(m)
            }
        }
        .frame(minHeight: ComposerMetrics.height)
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: ComposerMetrics.height / 2, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: ComposerMetrics.height / 2, style: .continuous))
        .onTapGesture { focused = true }
    }

    private func input(_ m: Model) -> some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(m.ctx.placeholder)
                    .foregroundStyle(Ob.text3)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            TextField("", text: $text, axis: .vertical)
                .lineLimit(1 ... 5)
                .focused($focused)
                .submitLabel(.done)
                .accessibilityLabel("새 작업")
                .accessibilityHint(m.ctx.placeholder)
                .onChange(of: text) { old, new in
                    // Edited after a paste: the offer goes.
                    if let p = pasted, new != p.joined { pasted = nil }
                    guard new.contains("\n") else { return }
                    // Return adds the task (↵ on the web); pasted lines become one, or one each when the
                    // offer above the field is taken.
                    let returned = new.hasSuffix("\n") && String(new.dropLast()) == old
                    let joined = new.replacingOccurrences(of: "\n", with: returned ? "" : " ")
                    if !returned {
                        let count = pasteLines(new).count
                        if count > 1 { pasted = PastedLines(raw: new, joined: joined, count: count) }
                    }
                    text = joined
                    if returned { Task { await submit() } }
                }
        }
        .font(ObFont.body)
        .foregroundStyle(Ob.text)
        .tint(Ob.text)
        .padding(.leading, 18)
        .padding(.vertical, (ComposerMetrics.height - 22) / 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func trailing(_ m: Model) -> some View {
        let canSend = !m.title.isEmpty
        if m.typing {
            Button {
                Task { await submit() }
            } label: {
                ZStack {
                    Circle().fill(canSend ? Ob.primary : Ob.surface3)
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Ob.onPrimary)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(canSend ? Ob.onPrimary : Ob.text3)
                    }
                }
                .frame(width: 34, height: 34)
                .frame(width: ComposerMetrics.height - 4, height: ComposerMetrics.height - 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(ComposerPressStyle())
            .disabled(!canSend || busy)
            .padding(.trailing, 2)
            .padding(.bottom, 2)
            .transition(.opacity)
            .accessibilityLabel("추가")
            .accessibilityHint(canSend ? "" : "제목을 함께 적어주세요")
        } else {
            Button {
                Haptics.select()
                helpOpen.toggle()
                focused = true
            } label: {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 18, weight: helpOpen ? .semibold : .regular))
                    .foregroundStyle(helpOpen ? Ob.text : Ob.text3)
                    .frame(width: ComposerMetrics.height - 4, height: ComposerMetrics.height - 4)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, 2)
            .padding(.bottom, 2)
            .transition(.opacity)
            .accessibilityLabel("입력 도움말")
            .accessibilityValue(helpOpen ? "열림" : "")
            .accessibilityHint("날짜, #프로젝트, !우선순위를 한 줄에 적을 수 있어요")
        }
    }

    // MARK: - actions

    private func openForm(_ m: Model) {
        var t = NewTask(title: text.composeTrimmed)
        t.projectId = m.ctx.projectId.flatMap { $0 }
        if take(.project, m), let jp = m.jevProject { t.projectId = jp.id }
        // The page's default date; dates in the text still win in the form.
        t.dueDate = m.ctx.defaultDueDate
        t.assigneeIds = m.ctx.defaultAssigneeId.map { [$0] } ?? []
        if take(.priority, m), let live = m.live { t.priority = live.priority.value }
        if take(.fixed, m) { t.fixed = true }
        t.estimateMinutes = m.parsed.estimateMinutes
        let kinds = disabled
        focused = false
        helpOpen = false
        router.present(.init(id: "new-task", detents: [.medium, .large]) {
            NewTaskSheet(prefill: t, disabled: kinds) { _ in
                text = ""
                disabled = []
                jev.reset()
            }
        })
    }

    /// 약속하기 전에 with what's typed (title, estimate, project, a typed due date to check).
    private func openCommit(_ m: Model) {
        var t = NewTask(title: m.title)
        t.estimateMinutes = m.parsed.estimateMinutes
        t.projectId = m.matched?.id ?? m.ctx.projectId.flatMap { $0 }
        t.dueDate = m.parsed.dueDate
        t.assigneeIds = m.ctx.defaultAssigneeId.map { [$0] } ?? []
        focused = false
        router.present(.init(id: "commit-new", detents: [.large]) {
            CommitSheet(prefill: t)
        })
    }

    /// 줄마다 작업 N개 만들기: every pasted line read like quick add, with this page's defaults (one undo).
    private func makeLines(_ p: PastedLines, _ m: Model) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let ctx = PasteContext(projectId: m.ctx.projectId.flatMap { $0 }, defaultDueDate: m.ctx.defaultDueDate, assigneeId: m.ctx.defaultAssigneeId)
        guard !(await store.pasteTasks(p.raw, ctx)).isEmpty else { return }
        text = ""
        disabled = []
        pasted = nil
        jev.reset()
    }

    private func submit() async {
        let m = model
        guard !m.title.isEmpty, !busy else { return }
        if let matched = m.matched, !store.canWriteProject(matched.id) {
            store.toasts.error("‘\(matched.name)’ 프로젝트는 보기 전용이라 작업을 추가할 수 없어요")
            return
        }
        busy = true
        defer { busy = false }
        var pid: String? = m.ctx.projectId.flatMap { $0 }
        if let name = m.parsed.projectName {
            if let matched = m.matched {
                pid = matched.id
            } else if let p = await store.createProject(name: name) {
                pid = p.id
            }
        }
        if take(.project, m), let jp = m.jevProject { pid = jp.id }
        var input = NewTask(title: m.title)
        input.projectId = pid
        input.startDate = m.parsed.startDate
        input.startTime = m.parsed.startTime
        input.dueDate = m.due
        input.dueTime = m.parsed.dueDate != nil ? m.parsed.dueTime : nil
        input.priority = m.parsed.priority ?? (take(.priority, m) ? m.live?.priority.value ?? 0 : 0)
        input.fixed = m.parsed.fixed || take(.fixed, m)
        input.assigneeIds = m.ctx.defaultAssigneeId.map { [$0] } ?? []
        input.estimateMinutes = m.parsed.estimateMinutes
        guard let created = await store.createTask(input) else { return }
        Haptics.tap()
        text = ""
        disabled = []
        pasted = nil
        jev.reset()
        if !ComposeContext.shows(created, on: page, store) {
            // It went somewhere this page doesn't list: say so, with a way there.
            store.toasts.show("“\(created.title)” 추가됨", action: .init(label: "보기") { [router] in
                router.openTask(created.id)
            })
        }
    }
}

enum ComposerMetrics {
    /// Field and "+" height (web inline field: 48px, radius 24).
    static let height: CGFloat = 48
}

/// Send button press: a slight dip, no bounce.
private struct ComposerPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(ObMotion.fast, value: configuration.isPressed)
    }
}

