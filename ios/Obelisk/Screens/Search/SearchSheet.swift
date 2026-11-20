import SwiftUI

/// 검색 (web CommandPalette): find a task by title or #number, jump to a page, project or setting,
/// switch spaces, start a new task or a Jev pass. Empty, it lists every command, like the web.
struct SearchSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var q: String
    @FocusState private var focused: Bool

    /// `query`: start with this search (e.g. a deep link); empty lists every command.
    init(query: String = "") {
        _q = State(initialValue: query)
    }

    var body: some View {
        let items = self.items
        let groups = Self.group(items)

        NavigationStack {
            List {
                ForEach(groups) { g in
                    Section {
                        ForEach(g.items) { c in
                            row(c)
                        }
                    } header: {
                        Text(g.name)
                            .font(ObFont.footnote.weight(.semibold))
                            .foregroundStyle(Ob.text3)
                            .textCase(nil)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Ob.bg)
            .environment(\.defaultMinListRowHeight, ObSize.row)
            .listSectionSpacing(ObSpace.sm)
            .scrollDismissesKeyboard(.immediately)
            .overlay {
                if items.isEmpty {
                    VStack(spacing: ObSpace.sm) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 20))
                            .foregroundStyle(Ob.text3)
                            .padding(.bottom, ObSpace.xs)
                        Text("결과가 없어요")
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                        Text("다른 검색어나 작업 번호(#12)로 찾아보세요.")
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text3)
                            .multilineTextAlignment(.center)
                    }
                    .padding(ObSpace.xxl)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.top, ObSpace.xxxl)
                }
            }
            .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "작업 검색, 이동, 명령…")
            .searchFocused($focused)
            .onSubmit(of: .search) {
                // Return runs the first result, like ↵ on the web.
                items.first?.run()
            }
            .navigationTitle("검색")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("닫기")
                }
            }
        }
        .onAppear { focused = true }
    }

    // MARK: - rows

    private func row(_ c: SearchCommand) -> some View {
        Button {
            Haptics.select()
            c.run()
        } label: {
            HStack(spacing: 12) {
                Group {
                    if let color = c.color {
                        RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 10, height: 10)
                    } else {
                        Image(systemName: c.symbol)
                            .font(.system(size: 16))
                            .foregroundStyle(c.muted ? Ob.text4 : Ob.text2)
                    }
                }
                .frame(width: 24)
                if let number = c.number {
                    Text("#\(number)")
                        .font(ObFont.footnote.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                }
                Text(c.label)
                    .font(ObFont.body)
                    .foregroundStyle(c.muted ? Ob.text3 : Ob.text)
                    .strikethrough(c.muted && c.done, color: Ob.text4)
                    .lineLimit(1)
                Spacer(minLength: ObSpace.sm)
                if let hint = c.hint {
                    Text(hint)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .lineLimit(1)
                }
            }
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: ObSpace.page, bottom: 0, trailing: ObSpace.page))
        .listRowBackground(Ob.bg)
        .listRowSeparator(.hidden)
        .accessibilityLabel([c.number.map { "#\($0)" }, c.label, c.hint].compactMap { $0 }.joined(separator: ", "))
    }

    // MARK: - commands (web CommandPalette `items`)

    private var items: [SearchCommand] {
        var base: [SearchCommand] = [
            SearchCommand(id: "new", label: "새 작업 만들기", symbol: "plus", group: "명령") { [router] in
                router.present(.init(id: "new-task", detents: [.medium, .large]) { NewTaskSheet(prefill: router.newTaskPrefill) })
            },
        ]
        if store.user?.jev.connected ?? false {
            base += [
                SearchCommand(id: "jev-priority", label: "Jev · 우선순위 정리", hint: "중요도와 마감으로 제안", symbol: "flag", group: "Jev") { [router] in
                    router.presentJev(.priority)
                },
                SearchCommand(id: "jev-postpone", label: "Jev · 오늘 미룰 작업 고르기", symbol: "calendar.badge.clock", group: "Jev") { [router] in
                    router.presentJev(.postpone(scope: .today))
                },
                SearchCommand(id: "jev-postpone-week", label: "Jev · 이번 주 일정 고르게 펴기", symbol: "calendar", group: "Jev") { [router] in
                    router.presentJev(.postpone(scope: .week))
                },
            ]
        }
        base += [
            go("home", "홈", .home),
            go("overview", "모아보기", .overview, hint: "모든 공간의 내 일"),
            go("today", "오늘", .today),
            go("upcoming", "예정", .upcoming),
            go("inbox", "인박스", .inbox),
            go("forecast", "파급 예측", .forecast),
            go("all", "전체 작업", .all),
            go("logbook", "완료 기록", .logbook),
            settings("ai", "AI 연결 (MCP · Skill)", .ai),
            settings("jev", "Jev 설정", .jev, hint: "판단 모델 연결"),
            settings("settings", "설정", nil),
        ]
        if store.isOrg {
            base += [
                go("mine", "내 작업", .mine),
                settings("org", "조직 설정 · 멤버 · 팀", .org),
            ]
        }
        base += store.workspaces.filter { $0.id != store.workspace?.id }.map { w in
            SearchCommand(
                id: "w-\(w.id)",
                label: "\(w.kind == .personal ? "개인 공간" : w.name)(으)로 전환",
                hint: w.kind == .personal ? "나만 보는 공간" : "멤버 \(w.memberCount)명",
                symbol: w.kind == .personal ? "person" : "building.2",
                group: "공간"
            ) { [router, store] in
                router.dismissSheet()
                router.open(.home)
                Task { await store.switchWorkspace(w.id) }
            }
        }
        base += store.openProjects.map { p in
            SearchCommand(id: "p-\(p.id)", label: p.name, symbol: "folder", color: p.color.palette.ink, group: "프로젝트") { [router] in
                Self.open(router, .project(p.id))
            }
        }

        let needle = Self.needle(q)
        let filtered = needle.isEmpty ? base : base.filter { $0.label.lowercased().contains(needle) }
        guard !needle.isEmpty else { return filtered }
        let tasks = store.taskList
            .filter { $0.title.lowercased().contains(needle) || String($0.number) == needle }
            .sorted { a, b in
                let ra = a.isActive ? 0 : 1
                let rb = b.isActive ? 0 : 1
                return ra != rb ? ra < rb : a.number > b.number
            }
            .prefix(12)
            .map { t in
                SearchCommand(
                    id: "t-\(t.id)",
                    label: t.title,
                    hint: t.dueDate.map { formatRelativeKo($0, store.today) },
                    symbol: t.status == .done ? "checkmark.circle" : "circle.dashed",
                    group: "작업",
                    number: t.number,
                    muted: !t.isActive,
                    done: t.status == .done
                ) { [router] in
                    router.openTask(t.id)
                }
            }
        return tasks + filtered
    }

    private func go(_ id: String, _ label: String, _ page: Page, hint: String? = nil) -> SearchCommand {
        SearchCommand(id: id, label: label, hint: hint, symbol: page.symbol, group: "이동") { [router] in
            Self.open(router, page)
        }
    }

    private func settings(_ id: String, _ label: String, _ page: SettingsPage?, hint: String? = nil) -> SearchCommand {
        SearchCommand(id: id, label: label, hint: hint, symbol: page?.symbol ?? "gearshape", group: "이동") { [router] in
            router.dismissSheet()
            router.openSettings(page)
        }
    }

    /// Open a sidebar page from anywhere (also from a pushed screen), then close the sheet.
    @MainActor
    private static func open(_ router: Router, _ page: Page) {
        router.dismissSheet()
        router.path = NavigationPath()
        router.open(page)
    }

    /// Lower-cased query without a leading "#", so "#12" finds task 12 and "#블로그" the project.
    static func needle(_ q: String) -> String {
        var n = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if n.hasPrefix("#") { n.removeFirst() }
        return n
    }

    /// Consecutive items with the same group form one section.
    static func group(_ items: [SearchCommand]) -> [SearchGroup] {
        var out: [SearchGroup] = []
        for c in items {
            if let last = out.indices.last, out[last].name == c.group {
                out[last].items.append(c)
            } else {
                out.append(SearchGroup(index: out.count, name: c.group, items: [c]))
            }
        }
        return out
    }
}

struct SearchCommand: Identifiable {
    var id: String
    var label: String
    var hint: String?
    var symbol: String
    var color: Color?
    var group: String
    /// Tasks show their #number before the title.
    var number: Int?
    /// A finished or canceled task.
    var muted = false
    var done = false
    var run: @MainActor () -> Void

    init(
        id: String, label: String, hint: String? = nil, symbol: String, color: Color? = nil, group: String,
        number: Int? = nil, muted: Bool = false, done: Bool = false, run: @escaping @MainActor () -> Void
    ) {
        self.id = id
        self.label = label
        self.hint = hint
        self.symbol = symbol
        self.color = color
        self.group = group
        self.number = number
        self.muted = muted
        self.done = done
        self.run = run
    }
}

struct SearchGroup: Identifiable {
    var index: Int
    var name: String
    var items: [SearchCommand]
    var id: String { "\(index)-\(name)" }
}
