import SwiftUI

enum TaskDetailLinkMode {
    /// 먼저 끝나야 하는 작업: tasks this one waits for.
    case blockedBy
    /// 이 작업을 기다리는 작업: tasks waiting for this one.
    case blocks

    var title: String {
        switch self {
        case .blockedBy: "먼저 끝나야 하는 작업"
        case .blocks: "이 작업을 기다리는 작업"
        }
    }

    var empty: String {
        switch self {
        case .blockedBy: "이 작업을 막고 있는 작업이 없어요"
        case .blocks: "이 작업 뒤에 이어지는 작업이 없어요"
        }
    }

    var symbol: String {
        switch self {
        case .blockedBy: "lock"
        case .blocks: "link"
        }
    }
}

/// One dependency list with 추가 and 연결 해제 (web DependencySection).
struct TaskDetailDependencySection: View {
    var mode: TaskDetailLinkMode
    var task: TaskItem
    var readOnly: Bool
    var onAdd: () -> Void

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let list = mode == .blockedBy ? store.blockers(of: task.id) : store.dependents(of: task.id)
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            TaskDetailSectionHead(icon: mode.symbol, title: mode.title, count: list.count) {
                if !readOnly {
                    Button(action: onAdd) {
                        Label("추가", systemImage: "plus")
                            .foregroundStyle(Ob.text2)
                    }
                    .buttonStyle(.ob(.ghost, size: .small))
                    .accessibilityLabel("\(mode.title) 추가")
                }
            }
            if list.isEmpty {
                Text(mode.empty)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, ObSpace.md)
                    .padding(.vertical, ObSpace.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: ObRadius.md)
                            .strokeBorder(Ob.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    )
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, t in
                        if index > 0 { Hairline().padding(.leading, ObSpace.md + 15 + 10) }
                        row(t)
                    }
                }
                .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: ObRadius.md))
            }
        }
        .animation(ObMotion.standard, value: list.map(\.id))
    }

    private func row(_ t: TaskItem) -> some View {
        let done = t.status == .done || t.status == .canceled
        let p = store.project(t.projectId)
        return HStack(spacing: 0) {
            Button {
                router.openTask(t.id)
            } label: {
                HStack(spacing: 10) {
                    TaskDetailStatusIcon(status: t.status)
                    HStack(spacing: 6) {
                        Text("#\(t.number)")
                            .font(ObFont.caption.monospacedDigit())
                            .foregroundStyle(Ob.text3)
                        Text(t.title)
                            .font(ObFont.sub)
                            .foregroundStyle(done ? Ob.text3 : Ob.text)
                            .strikethrough(done, color: Ob.text4)
                            .lineLimit(1)
                    }
                    Spacer(minLength: ObSpace.xs)
                    if let p, p.id != task.projectId {
                        Circle().fill(p.color.palette.ink).frame(width: 7, height: 7)
                            .accessibilityLabel(p.name)
                    }
                    if let d = t.dueDate {
                        Text(formatShortKo(d))
                            .font(ObFont.caption.monospacedDigit())
                            .foregroundStyle(Ob.text3)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .padding(.leading, ObSpace.md)
                .padding(.trailing, readOnly ? ObSpace.md : ObSpace.xs)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.obRow)
            .accessibilityElement(children: .combine)
            .accessibilityHint("작업 열기")

            if !readOnly {
                Button {
                    remove(t)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Ob.text3)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TaskDetailPressStyle())
                .accessibilityLabel("연결 해제")
            }
        }
        .contextMenu {
            Button {
                router.openTask(t.id)
            } label: {
                Label("열기", systemImage: "arrow.up.right")
            }
            if !readOnly {
                Button(role: .destructive) {
                    remove(t)
                } label: {
                    Label("연결 해제", systemImage: "xmark")
                }
            }
        }
    }

    private func remove(_ t: TaskItem) {
        Task {
            if mode == .blockedBy {
                await store.removeDependency(task.id, dependsOn: t.id)
            } else {
                await store.removeDependency(t.id, dependsOn: task.id)
            }
        }
    }
}

/// Pick a task to link: open tasks of this workspace that wouldn't close a loop, this project's first
/// (web DependencySection popover).
struct TaskDetailDependencyPicker: View {
    var mode: TaskDetailLinkMode
    var taskId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            let found = candidates
            List {
                if found.isEmpty {
                    Text("연결할 수 있는 작업이 없어요")
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text3)
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .listRowBackground(Ob.bg)
                        .listRowSeparator(.hidden)
                }
                ForEach(found) { t in
                    Button {
                        add(t)
                    } label: {
                        HStack(spacing: ObSpace.sm) {
                            Text("#\(t.number)")
                                .font(ObFont.footnote.monospacedDigit())
                                .foregroundStyle(Ob.text3)
                            Text(t.title)
                                .font(ObFont.body)
                                .foregroundStyle(Ob.text)
                                .lineLimit(1)
                            Spacer(minLength: ObSpace.sm)
                            if let d = t.dueDate {
                                Text(formatRelativeKo(d, store.today))
                                    .font(ObFont.footnote)
                                    .foregroundStyle(Ob.text3)
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                        }
                        .frame(minHeight: 36)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Ob.bg)
                    .listRowSeparatorTint(Ob.border)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .obPage()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "작업 검색 (제목 또는 #번호)")
            .onSubmit(of: .search) {
                if let first = found.first { add(first) }
            }
            .navigationTitle(mode.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
        }
    }

    private var candidates: [TaskItem] {
        guard let task = store.task(taskId) else { return [] }
        let list = mode == .blockedBy ? store.blockers(of: taskId) : store.dependents(of: taskId)
        let existing = Set(list.map(\.id))
        let q = query.lowercased()
        let number = query.replacingOccurrences(of: "#", with: "")
        let deps = store.deps
        return store.taskList
            .filter { $0.id != taskId && !existing.contains($0.id) && $0.isActive }
            .filter { mode == .blockedBy ? !wouldCreateCycle(deps, taskId, $0.id) : !wouldCreateCycle(deps, $0.id, taskId) }
            .filter { query.isEmpty || $0.title.lowercased().contains(q) || String($0.number) == number }
            .sorted { a, b in
                let ap = a.projectId == task.projectId ? 0 : 1
                let bp = b.projectId == task.projectId ? 0 : 1
                return ap != bp ? ap < bp : a.number > b.number
            }
            .prefix(30)
            .map { $0 }
    }

    private func add(_ other: TaskItem) {
        dismiss()
        Task {
            if mode == .blockedBy {
                await store.addDependency(taskId, dependsOn: other.id)
            } else {
                await store.addDependency(other.id, dependsOn: taskId)
            }
        }
    }
}

/// Jev's likely "must finish first" / "waits for this" links (web JevLinks). Only when Jev is connected.
struct TaskDetailJevLinks: View {
    var task: TaskItem

    private enum Phase {
        case idle, loading
        case failed(String)
        case ready(blockedBy: [DependencySuggestion], blocks: [DependencySuggestion])
    }

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var phase: Phase = .idle

    var body: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Image(systemName: "scalemass")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Ob.text3)
                    .frame(width: 16)
                Text("Jev 연결 제안")
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if !isLoading {
                    Button(isIdle ? "선후 관계 찾기" : "다시 찾기") {
                        Task { await run() }
                    }
                    .buttonStyle(.ob(.ghost, size: .small))
                }
            }
            .frame(minHeight: 28)

            switch phase {
            case .idle:
                note("같은 프로젝트에서 먼저 끝나야 할 일과 이 작업을 기다릴 일을 찾아 연결을 제안해요.")
            case .loading:
                HStack(spacing: ObSpace.sm) {
                    ProgressView().controlSize(.small)
                    note("Jev가 살펴보는 중…")
                }
            case let .failed(message):
                Text(message)
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.dangerText)
                    .fixedSize(horizontal: false, vertical: true)
            case let .ready(blockedBy, blocks):
                let rows = (blockedBy + blocks).filter { store.task($0.taskId) != nil && !linked($0) }
                if rows.isEmpty {
                    note(blockedBy.count + blocks.count > 0 ? "제안한 연결을 모두 반영했어요." : "순서가 분명한 작업을 찾지 못했어요.")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { index, sg in
                            if index > 0 { Hairline() }
                            if let other = store.task(sg.taskId) { suggestionRow(sg, other) }
                        }
                    }
                    .padding(.horizontal, ObSpace.md)
                    .obCard(padding: 0, radius: ObRadius.md)
                }
            }
        }
        .animation(ObMotion.standard, value: phaseKey)
    }

    private var isIdle: Bool { if case .idle = phase { true } else { false } }
    private var isLoading: Bool { if case .loading = phase { true } else { false } }

    private var phaseKey: String {
        switch phase {
        case .idle: "idle"
        case .loading: "loading"
        case .failed: "failed"
        case let .ready(a, b): "ready-\(a.count)-\(b.count)-\(store.deps.count)"
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(ObFont.footnote)
            .foregroundStyle(Ob.text3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func linked(_ sg: DependencySuggestion) -> Bool {
        sg.direction == .blockedBy
            ? store.deps.contains { $0.taskId == task.id && $0.dependsOnId == sg.taskId }
            : store.deps.contains { $0.taskId == sg.taskId && $0.dependsOnId == task.id }
    }

    private func suggestionRow(_ sg: DependencySuggestion, _ other: TaskItem) -> some View {
        let first = sg.direction == .blockedBy
        return HStack(spacing: ObSpace.sm) {
            HStack(spacing: 3) {
                Image(systemName: first ? "lock" : "link").font(.system(size: 10))
                Text(first ? "먼저" : "다음")
            }
            .font(ObFont.caption.weight(.medium))
            .foregroundStyle(Ob.text2)
            .frame(width: 44, alignment: .leading)

            Button {
                router.openTask(other.id)
            } label: {
                HStack(spacing: 6) {
                    Text("#\(other.number)")
                        .font(ObFont.caption.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    Text(other.title)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(TaskDetailPressStyle())

            Text("\(Int((sg.probability * 100).rounded()))%")
                .font(ObFont.caption.monospacedDigit())
                .foregroundStyle(Ob.text3)

            Button("연결") {
                Task {
                    if first {
                        await store.addDependency(task.id, dependsOn: other.id)
                    } else {
                        await store.addDependency(other.id, dependsOn: task.id)
                    }
                }
            }
            .buttonStyle(.ob(.outline, size: .small))
            .accessibilityHint(first ? "#\(other.number)이 끝나야 이 작업을 시작해요" : "이 작업이 끝나야 #\(other.number)을 시작해요")
        }
    }

    private func run() async {
        withAnimation(ObMotion.standard) { phase = .loading }
        do {
            let r: DependencyResult = try await API.shared.send(.post, "/api/jev/dependencies", json: ["taskId": .string(task.id)])
            withAnimation(ObMotion.standard) { phase = .ready(blockedBy: r.blockedBy, blocks: r.blocks) }
        } catch {
            if let e = error as? APIError, e.isUnauthorized {
                store.report(error)
                return
            }
            let message = (error as? LocalizedError)?.errorDescription ?? "Jev에 묻지 못했어요"
            withAnimation(ObMotion.standard) { phase = .failed(message.isEmpty ? "Jev에 묻지 못했어요" : message) }
        }
    }
}
