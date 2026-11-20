import SwiftUI

/// ChatGPT-style sidebar (web components/Sidebar.tsx): search · pages with counts · 프로젝트 ·
/// 다가오는 일정 · account. Plain 44pt rows with a quiet selected fill; counts are muted numbers
/// (red when something is overdue, orange when slipping).
struct SidebarView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var addingProject = false
    @State private var projectName = ""
    @FocusState private var projectFieldFocused: Bool

    var body: some View {
        let counts = store.sidebarCounts
        VStack(spacing: 0) {
            top
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    pages(counts)
                        .padding(.top, ObSpace.sm)
                    projects(counts)
                        .padding(.top, ObSpace.xl)
                    if !counts.events.isEmpty {
                        events(counts)
                            .padding(.top, ObSpace.xl)
                    }
                }
                .padding(.horizontal, ObSpace.sm)
                .padding(.bottom, ObSpace.xl)
            }
            .scrollIndicators(.hidden)
            account
        }
        .frame(maxHeight: .infinity)
        .background(Ob.bg.ignoresSafeArea())
    }

    // MARK: top: search capsule + new task

    private var top: some View {
        HStack(spacing: ObSpace.sm) {
            Button {
                router.sidebarOpen = false
                router.present(.init(id: "search", detents: [.large]) { SearchSheet() })
            } label: {
                HStack(spacing: ObSpace.sm) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Ob.text3)
                    Text("검색")
                        .foregroundStyle(Ob.text3)
                    Spacer()
                }
                .font(ObFont.body)
                .padding(.horizontal, ObSpace.md)
                .frame(height: 40)
                .background(Ob.surface2, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("검색")

            Button {
                router.sidebarOpen = false
                router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: router.newTaskPrefill) })
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Ob.text)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("새 작업")
        }
        .padding(.horizontal, ObSpace.md)
        .padding(.top, ObSpace.sm)
        .padding(.bottom, ObSpace.xs)
    }

    // MARK: pages

    private func pages(_ c: SidebarCounts) -> some View {
        VStack(spacing: 0) {
            row(.home)
            // 모아보기 gathers every space, so it only earns a place once there is more than one.
            if store.workspaces.count > 1 { row(.overview) }
            row(.inbox, count: c.inbox)
            row(.today, count: c.today, tone: c.overdue > 0 ? .danger : .neutral)
            row(.upcoming)
            if store.isOrg { row(.mine, count: c.mine) }
            row(.all)
            row(.forecast, count: c.risk, tone: c.conflicts > 0 ? .danger : (c.risk > 0 ? .warn : .neutral))
            row(.logbook)
        }
    }

    private func row(_ page: Page, count: Int = 0, tone: Tone = .neutral) -> some View {
        let active = router.page == page && router.path.isEmpty
        return Button {
            Haptics.select()
            router.open(page)
        } label: {
            HStack(spacing: ObSpace.md) {
                Image(systemName: page.symbol)
                    .font(.system(size: 17))
                    .frame(width: 24)
                    .foregroundStyle(Ob.text2)
                Text(page.label)
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
                Spacer(minLength: ObSpace.sm)
                if count > 0 { CountText(count: count, tone: tone) }
            }
            .padding(.horizontal, ObSpace.md)
            .frame(height: ObSize.row)
        }
        .buttonStyle(.obRow(selected: active))
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: projects

    private func projects(_ c: SidebarCounts) -> some View {
        let list = store.openProjects
        let canCreate = store.workspace?.canCreateProjects ?? true
        return VStack(alignment: .leading, spacing: 0) {
            SectionLabel("프로젝트") {
                if canCreate {
                    Button {
                        addingProject = true
                        projectFieldFocused = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Ob.text3)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("프로젝트 추가")
                }
            }
            .padding(.horizontal, ObSpace.md)
            .padding(.bottom, ObSpace.xs)

            ForEach(list) { p in
                let active = router.page == .project(p.id) && router.path.isEmpty
                Button {
                    Haptics.select()
                    router.open(.project(p.id))
                } label: {
                    HStack(spacing: ObSpace.md) {
                        ProjectSwatch(color: p.color)
                            .frame(width: 24)
                        Text(p.name)
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        if store.isOrg, p.access == .view {
                            Image(systemName: "eye")
                                .font(.system(size: 13))
                                .foregroundStyle(Ob.text3)
                                .accessibilityLabel("보기 전용")
                        }
                        Spacer(minLength: ObSpace.sm)
                        if let n = c.byProject[p.id], n > 0 { CountText(count: n) }
                    }
                    .padding(.horizontal, ObSpace.md)
                    .frame(height: ObSize.row)
                }
                .buttonStyle(.obRow(selected: active))
            }

            if addingProject {
                HStack(spacing: ObSpace.md) {
                    ProjectSwatch(color: nil).frame(width: 24)
                    TextField("프로젝트 이름", text: $projectName)
                        .font(ObFont.body)
                        .focused($projectFieldFocused)
                        .submitLabel(.done)
                        .onSubmit { submitProject() }
                        .onChange(of: projectFieldFocused) { _, focused in
                            if !focused { submitProject() }
                        }
                }
                .padding(.horizontal, ObSpace.md)
                .frame(height: ObSize.row)
                .background(Ob.surface2, in: RoundedRectangle(cornerRadius: ObRadius.md))
            } else if list.isEmpty {
                if canCreate {
                    Button {
                        addingProject = true
                        projectFieldFocused = true
                    } label: {
                        HStack(spacing: ObSpace.md) {
                            Image(systemName: "plus").frame(width: 24)
                            Text("첫 프로젝트 만들기")
                            Spacer()
                        }
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text3)
                        .padding(.horizontal, ObSpace.md)
                        .frame(height: ObSize.row)
                    }
                    .buttonStyle(.obRow)
                } else {
                    Text("아직 볼 수 있는 프로젝트가 없어요. 관리자에게 공유를 요청하세요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .padding(.horizontal, ObSpace.md)
                        .padding(.vertical, ObSpace.sm)
                }
            }
        }
    }

    private func submitProject() {
        let name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        addingProject = false
        projectName = ""
        guard !name.isEmpty else { return }
        let color = ProjectColor.allCases[(store.openProjects.count + 6) % ProjectColor.allCases.count]
        Task {
            if let p = await store.createProject(name: name, color: color) {
                router.open(.project(p.id))
            }
        }
    }

    // MARK: upcoming fixed commitments

    private func events(_ c: SidebarCounts) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel("다가오는 일정")
                .padding(.horizontal, ObSpace.md)
                .padding(.bottom, ObSpace.xs)
            ForEach(c.events.prefix(SidebarCounts.eventCap), id: \.task.id) { e in
                Button {
                    router.sidebarOpen = false
                    router.openTask(e.task.id)
                } label: {
                    HStack(spacing: ObSpace.md) {
                        Text(e.task.title)
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        Spacer(minLength: ObSpace.sm)
                        Text(e.label)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                    }
                    .padding(.horizontal, ObSpace.md)
                    .frame(height: ObSize.row)
                }
                .buttonStyle(.obRow)
            }
            if c.events.count > SidebarCounts.eventCap {
                Button {
                    router.open(.upcoming)
                } label: {
                    Text("외 \(c.events.count - SidebarCounts.eventCap)개 더 보기")
                        .font(ObFont.body)
                        .foregroundStyle(Ob.text3)
                        .padding(.horizontal, ObSpace.md)
                        .frame(maxWidth: .infinity, minHeight: ObSize.row, alignment: .leading)
                }
                .buttonStyle(.obRow)
            }
        }
    }

    // MARK: account

    @AppStorage("obelisk-theme", store: AppGroup.defaults) private var theme: ThemePref = .system

    private var account: some View {
        VStack(spacing: 0) {
            Hairline()
            Menu {
                Button {
                    router.openSettings()
                } label: {
                    Label("설정", systemImage: "gearshape")
                }
                Button {
                    router.openSettings(.ai)
                } label: {
                    Label("AI 연결", systemImage: "powerplug")
                }
                if store.user?.isAdmin == true {
                    Button {
                        router.openSettings(.admin)
                    } label: {
                        Label("서버 관리", systemImage: "shield")
                    }
                }
                Divider()
                Picker("테마", selection: $theme) {
                    ForEach(ThemePref.allCases) { t in
                        Label(t.label, systemImage: t.symbol).tag(t)
                    }
                }
                .pickerStyle(.palette)
                Divider()
                Button(role: .destructive) {
                    Task { await store.logout() }
                } label: {
                    Label("로그아웃", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                HStack(spacing: ObSpace.md) {
                    Avatar(name: store.user?.name ?? "?", size: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(store.user?.name ?? "계정")
                            .font(ObFont.body.weight(.medium))
                            .foregroundStyle(Ob.text)
                            .lineLimit(1)
                        Text(store.user?.email ?? "")
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.text3)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "ellipsis")
                        .foregroundStyle(Ob.text3)
                }
                .padding(.horizontal, ObSpace.lg)
                .frame(height: 60)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("계정 메뉴")
        }
    }
}
