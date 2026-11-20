import SwiftUI
import UIKit

/// 프로젝트 (web app/(app)/projects/[id]/page.tsx): name (renamable with manage access), progress and
/// meta line, the slice of the live forecast that reaches this project, its tasks as a list or a
/// timeline (remembered, web usePref 'project-mode'), and the ••• menu: 공유 (organizations),
/// 이름 바꾸기 · 색상 · 다른 공간으로 옮기기 · 보관 · 삭제 (manage access).
struct ProjectScreen: View {
    var projectId: String

    @Environment(AppStore.self) private var store

    var body: some View {
        if let project = store.project(projectId) {
            ProjectContent(project: project)
        } else {
            ScrollView {
                EmptyState("프로젝트를 찾을 수 없어요", message: "삭제되었거나 보관된 프로젝트일 수 있어요.") {
                    ListsPageButton(title: "전체 작업 보기", symbol: "square.stack.3d.up", page: .all)
                }
                .padding(.top, ObSpace.xxxl)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(Ob.bg)
        }
    }
}

private struct ProjectData {
    var mine: [TaskItem]
    var active: [TaskItem]
    var done: [TaskItem]
    /// The latest date among open tasks (예상 완료).
    var finish: ISODate?

    init(_ tasks: [TaskItem], projectId: String) {
        mine = tasks.filter { $0.projectId == projectId }
        active = sortTasks(mine.filter(\.isActive))
        done = mine.filter { $0.status == .done }.listsByCompletion()
        finish = active.compactMap { $0.dueDate ?? $0.startDate }.max()
    }
}

/// Only the part of the live forecast that reaches this project: its pushed or conflicting tasks plus the
/// upstream chain (possibly in other projects) that causes them.
private struct ProjectRisk {
    var touched: [TaskImpact]
    var slip: ProjectSlip?
    var report: ImpactReport

    init(_ fc: ImpactReport, projectId id: String) {
        touched = fc.impacts.filter { $0.projectId == id && ($0.kind == .shifted || $0.kind == .conflict) }
        var byId: [String: TaskImpact] = [:]
        for im in fc.impacts where byId[im.taskId] == nil { byId[im.taskId] = im }
        var keep = Set<String>()
        for im in touched {
            var cur: TaskImpact? = im
            while let c = cur, !keep.contains(c.taskId) {
                keep.insert(c.taskId)
                cur = c.viaId.flatMap { byId[$0] }
            }
        }
        let impacts = fc.impacts.filter { keep.contains($0.taskId) }
        slip = fc.summary.projectSlips.first { $0.projectId == id }
        var summary = fc.summary
        summary.delayedCount = impacts.filter { $0.kind == .shifted }.count
        summary.conflictCount = impacts.filter { $0.kind == .conflict }.count
        summary.absorbedCount = 0
        summary.unscheduledCount = 0
        summary.maxShiftDays = max(0, impacts.map { $0.kind == .conflict ? $0.overrunDays : $0.shiftDays }.max() ?? 0)
        summary.projectSlips = slip.map { [$0] } ?? []
        report = ImpactReport(rootIds: fc.rootIds.filter { keep.contains($0) }, impacts: impacts, summary: summary)
    }
}

private struct ProjectContent: View {
    var project: Project

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @AppStorage("obelisk:project-mode") private var mode: ListsViewMode = .list

    @State private var editingName = false
    @State private var name = ""
    @FocusState private var nameFocused: Bool
    @State private var confirmDelete = false

    private var manage: Bool { project.access == .manage }
    private var readOnly: Bool { project.access == .view }

    var body: some View {
        let data = ProjectData(store.taskList, projectId: project.id)
        let risk = ProjectRisk(forecast(store.planItemsNow, store.deps, store.today), projectId: project.id)

        Group {
            switch mode {
            case .list: list(data, risk)
            case .timeline: timeline(data, risk)
            }
        }
        .onChange(of: nameFocused) { _, focused in
            if !focused, editingName { commitName() }
        }
        .onChange(of: project.id) { editingName = false }
    }

    // MARK: modes

    private func list(_ data: ProjectData, _ risk: ProjectRisk) -> some View {
        List {
            header(data, risk)
                .listsPlainRow()

            if !risk.touched.isEmpty {
                impact(risk)
                    .listsPlainRow(bottom: ObSpace.xl, horizontal: ObSpace.page)
            }

            TaskSection(nil, tasks: data.active, showProject: false)

            if data.active.isEmpty {
                EmptyState(
                    "진행 중인 작업이 없어요",
                    message: "작업을 추가하고, 작업 상세에서 ‘먼저 끝나야 하는 작업’을 연결하면 지연 예측이 시작돼요."
                ) {
                    if !readOnly {
                        ListsNewTaskButton(prefill: NewTask(title: "", projectId: project.id))
                    }
                }
                .listsPlainRow()
            }

            TaskSection("완료", tasks: data.done, showProject: false, collapsible: true, defaultCollapsed: true)
        }
        .obTaskList()
        .refreshable { await store.refresh() }
    }

    private func timeline(_ data: ProjectData, _ risk: ProjectRisk) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                header(data, risk)
                ListsTimeline(tasks: data.active + data.done.prefix(20))
            }
        }
        .listsTimelineHost()
        .refreshable { await store.refresh() }
    }

    // MARK: header

    private func header(_ data: ProjectData, _ risk: ProjectRisk) -> some View {
        ListsHeader {
            titleView
        } actions: {
            if store.isOrg || manage { menu(data) }
        } extra: {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                stats(data, risk)
                ListsModePicker(mode: $mode)
            }
            .padding(.top, ObSpace.sm)
        }
    }

    @ViewBuilder
    private var titleView: some View {
        HStack(alignment: .center, spacing: 10) {
            ProjectSwatch(color: project.color, size: 14)
                .accessibilityHidden(true)
            if editingName {
                TextField("프로젝트 이름", text: $name)
                    .font(ObFont.title)
                    .foregroundStyle(Ob.text)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit { commitName() }
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("프로젝트 이름")
            } else {
                Text(project.name)
                    .font(ObFont.title)
                    .foregroundStyle(Ob.text)
                    .lineLimit(2)
                    .contentShape(Rectangle())
                    .onTapGesture { if manage { startRename() } }
                    .accessibilityAddTraits(manage ? .isButton : [])
                    .accessibilityHint(manage ? "이름 바꾸기" : "")
            }
        }
    }

    private func stats(_ data: ProjectData, _ risk: ProjectRisk) -> some View {
        let total = data.active.count + data.done.count
        let pct = total > 0 ? Int((Double(data.done.count) / Double(total) * 100).rounded()) : 0
        let shareLabel = project.memberAccess == .edit ? "조직 전체 쓰기" : project.memberAccess == .view ? "조직 전체 보기" : "비공개"

        return FlowRow(spacing: ObSpace.lg, lineSpacing: 6) {
            HStack(spacing: ObSpace.sm) {
                ProjectProgressBar(value: total > 0 ? Double(data.done.count) / Double(total) : 0, ok: total > 0 && pct == 100)
                    .frame(width: 88)
                HStack(spacing: 3) {
                    Text("\(data.done.count)/\(total)")
                        .fontWeight(.medium)
                        .foregroundStyle(Ob.text)
                        .monospacedDigit()
                    Text("완료")
                }
                if total > 0 {
                    Text("\(pct)%")
                        .foregroundStyle(Ob.text3)
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("완료 비율 \(pct)%, \(total)개 중 \(data.done.count)개 완료")

            if store.isOrg {
                meta(project.memberAccess == .none ? "lock" : "person.2", shareLabel)
            }
            if let finish = data.finish {
                meta("flag", "예상 완료 \(formatRelativeKo(finish, store.today))")
            }
            if readOnly {
                meta("eye", "보기 전용")
            }
            if project.archivedAt != nil {
                meta("archivebox", "보관됨")
            }
            if let slip = risk.slip {
                meta("water.waves", "지연 예측 +\(slip.shiftDays)일 (\(formatRelativeKo(slip.to, store.today)) 완료)", tone: .warn)
            }
        }
        .font(ObFont.footnote)
        .foregroundStyle(Ob.text2)
    }

    private func meta(_ symbol: String, _ text: String, tone: Tone = .neutral) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 12))
                .foregroundStyle(tone == .neutral ? Ob.text3 : tone.ink)
            Text(text)
                .foregroundStyle(tone == .neutral ? Ob.text2 : tone.text)
        }
        .accessibilityElement(children: .combine)
    }

    private func impact(_ risk: ProjectRisk) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Image(systemName: "water.waves")
                    .font(.system(size: 14))
                    .foregroundStyle(Ob.warn)
                Text("이 프로젝트에 닿는 지연")
                    .font(ObFont.bodyStrong)
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: ObSpace.sm)
                Button {
                    router.open(.forecast)
                } label: {
                    HStack(spacing: 2) {
                        Text("파급 예측 열기")
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .font(ObFont.caption.weight(.medium))
                    .foregroundStyle(Ob.text3)
                    .frame(minHeight: ObSize.row)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            ImpactView(report: risk.report)
        }
    }

    // MARK: menu

    private func menu(_ data: ProjectData) -> some View {
        Menu {
            if store.isOrg {
                Button {
                    router.present(.init(id: "share", detents: [.large]) { ShareProjectSheet(projectId: project.id) })
                } label: {
                    Label("공유…", systemImage: "person.2")
                }
            }
            if manage {
                Button {
                    startRename()
                } label: {
                    Label("이름 바꾸기", systemImage: "pencil")
                }
                ProjectColorMenu(project: project)
                Divider()
                if store.workspaces.count > 1 {
                    Button {
                        router.present(.init(id: "move-project", detents: [.medium, .large]) { MoveProjectSheet(projectId: project.id) })
                    } label: {
                        Label("다른 공간으로 옮기기…", systemImage: "arrow.up.right")
                    }
                }
                if project.archivedAt == nil {
                    Button {
                        Task {
                            if await store.updateProject(project.id, ["archived": .bool(true)]) != nil {
                                store.toasts.show("“\(project.name)” 보관됨")
                                router.open(.all)
                            }
                        }
                    } label: {
                        Label("보관", systemImage: "archivebox")
                    }
                } else {
                    Button {
                        Task {
                            if await store.updateProject(project.id, ["archived": .bool(false)]) != nil {
                                store.toasts.show("“\(project.name)” 보관 해제됨")
                            }
                        }
                    } label: {
                        Label("보관 해제", systemImage: "tray.and.arrow.up")
                    }
                }
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("삭제…", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Ob.text2)
                .frame(width: ObSize.row, height: ObSize.row)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("프로젝트 메뉴")
        // Anchored to the ••• button (iOS presents it as a popover from its source).
        .confirmationDialog("프로젝트를 삭제할까요?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("삭제", role: .destructive) { delete(withTasks: false) }
            if !data.mine.isEmpty {
                Button("작업도 함께 삭제", role: .destructive) { delete(withTasks: true) }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text(data.mine.isEmpty
                ? "“\(project.name)” 프로젝트가 삭제돼요."
                : "“\(project.name)” 프로젝트가 삭제되고, 안의 작업 \(data.mine.count)개는 인박스로 옮겨져요.")
        }
        .padding(.trailing, -ObSpace.sm)
    }

    // MARK: actions

    private func startRename() {
        name = project.name
        withAnimation(ObMotion.fast) { editingName = true }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            nameFocused = true
        }
    }

    private func commitName() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        editingName = false
        nameFocused = false
        guard !n.isEmpty, n != project.name else { return }
        let id = project.id
        Task { await store.updateProject(id, ["name": .string(n)]) }
    }

    private func delete(withTasks: Bool) {
        let id = project.id
        Task {
            if await store.deleteProject(id, deleteTasks: withTasks) {
                router.open(.inbox)
            }
        }
    }
}

/// 색상: the ten project colours with their swatch, the current one checked.
private struct ProjectColorMenu: View {
    var project: Project
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Menu {
            Picker("색상", selection: Binding(
                get: { project.color },
                set: { c in
                    guard c != project.color else { return }
                    let id = project.id
                    Task { await store.updateProject(id, ["color": .string(c.rawValue)]) }
                }
            )) {
                ForEach(ProjectColor.allCases, id: \.self) { c in
                    Label {
                        Text(c.koName)
                    } icon: {
                        Image(uiImage: swatch(c))
                    }
                    .tag(c)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("색상", systemImage: "paintpalette")
        }
    }

    private func swatch(_ c: ProjectColor) -> UIImage {
        let ui = UIColor(c.palette.ink).resolvedColor(with: UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light))
        let size = CGSize(width: 18, height: 18)
        return UIGraphicsImageRenderer(size: size).image { _ in
            ui.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)).fill()
        }
        .withRenderingMode(.alwaysOriginal)
    }
}

private extension ProjectColor {
    /// Names for the colour menu and VoiceOver (the web labels swatches by their token).
    var koName: String {
        switch self {
        case .slate: "회색"
        case .red: "빨강"
        case .orange: "주황"
        case .amber: "노랑"
        case .green: "초록"
        case .teal: "청록"
        case .blue: "파랑"
        case .indigo: "남색"
        case .violet: "보라"
        case .pink: "분홍"
        }
    }
}

/// Thin progress track (web Progress size sm: 3px, primary fill; green at 100%).
private struct ProjectProgressBar: View {
    var value: Double
    var ok: Bool

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Ob.surface3)
                Capsule()
                    .fill(ok ? Ob.ok : Ob.primary)
                    .frame(width: g.size.width * min(1, max(0, value)))
            }
        }
        .frame(height: 3)
        .animation(ObMotion.slow, value: value)
        .accessibilityHidden(true)
    }
}
