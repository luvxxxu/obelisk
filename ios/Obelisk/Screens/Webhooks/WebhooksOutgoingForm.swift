import SwiftUI

/// 보내는 웹훅 추가 / 웹훅 수정 (web WebhookForm.tsx), in a sheet. After creating, the same sheet shows
/// the signing secret once (web RevealModal, fresh).
struct WebhooksOutgoingForm: View {
    var model: WebhooksModel
    /// nil = new webhook.
    var initial: Webhook?

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Scope: Hashable { case all, some }
    private enum Field: Hashable { case name, url }

    @State private var name: String
    @State private var url: String
    @State private var format: WebhookFormat
    /// The format was picked by hand (stop following the URL).
    @State private var formatTouched: Bool
    @State private var events: Set<WebhookEventKey>
    @State private var scope: Scope
    @State private var picked: Set<String>
    @State private var alertHour: Int
    @State private var remindMinutes: Int
    @State private var saving = false
    @State private var created: WebhooksRevealItem?
    @FocusState private var focus: Field?

    init(model: WebhooksModel, initial: Webhook?) {
        self.model = model
        self.initial = initial
        _name = State(initialValue: initial?.name ?? "")
        _url = State(initialValue: initial?.url ?? "")
        _format = State(initialValue: initial?.format ?? .json)
        _formatTouched = State(initialValue: initial.map { $0.format != detectWebhookFormat($0.url) } ?? false)
        _events = State(initialValue: Set(initial?.events ?? DEFAULT_WEBHOOK_EVENTS))
        _scope = State(initialValue: initial?.projectIds != nil ? .some : .all)
        _picked = State(initialValue: Set(initial?.projectIds ?? []))
        _alertHour = State(initialValue: initial?.alertHour ?? 9)
        _remindMinutes = State(initialValue: initial?.remindMinutes ?? DEFAULT_REMIND_MINUTES)
    }

    var body: some View {
        NavigationStack {
            if let created {
                WebhooksRevealContent(model: model, item: created) { dismiss() }
                    .transition(.opacity)
            } else {
                form
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(created != nil)
    }

    // MARK: derived (web WebhookForm)

    private var kind: WorkspaceKind { store.workspace?.kind ?? .personal }
    private var groups: [WebhookEventGroup] { WEBHOOK_EVENT_GROUPS.filter { !$0.orgOnly || kind == .org } }
    private var hasSchedule: Bool { events.contains { isScheduleEvent($0.rawValue) } }
    private var hasReminder: Bool { events.contains { isReminderEvent($0.rawValue) } }

    private func zone(changed: Bool) -> String {
        if let initial, !changed { return initial.timezone }
        return store.user?.timezone ?? "Asia/Seoul"
    }

    private var liveProjects: [Project] {
        store.projects.filter { $0.archivedAt == nil || picked.contains($0.id) }.sorted { $0.position < $1.position }
    }

    private static let urlPattern = JSRegex("^https?://[^\\s/]+", ignoreCase: true)

    private var problem: String? {
        if JS.trim(name).isEmpty { return "이름을 입력하세요" }
        if !Self.urlPattern.test(JS.trim(url)) { return "https://로 시작하는 URL을 입력하세요" }
        if events.isEmpty { return "보낼 이벤트를 하나 이상 고르세요" }
        if scope == .some, picked.isEmpty { return "프로젝트를 하나 이상 고르세요" }
        return nil
    }

    private var urlBinding: Binding<String> {
        Binding(get: { url }, set: { v in
            url = v
            if !formatTouched { format = detectWebhookFormat(JS.trim(v)) }
        })
    }

    private var formatBinding: Binding<WebhookFormat> {
        Binding(get: { format }, set: { v in
            format = v
            formatTouched = true
        })
    }

    // MARK: form

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.xxl) {
                Text("Obelisk에서 일어난 일을 다른 서비스로 보내요.")
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text2)

                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    WebhooksFieldLabel("이름")
                    TextField("예: #팀-알림 채널", text: $name)
                        .textFieldStyle(.ob(focused: focus == .name))
                        .focused($focus, equals: .name)
                        .submitLabel(.next)
                        .onSubmit { focus = .url }
                        .onChange(of: name) { _, v in if v.count > 80 { name = String(v.prefix(80)) } }
                        .accessibilityLabel("이름")
                }

                VStack(alignment: .leading, spacing: ObSpace.sm) {
                    WebhooksFieldLabel("URL")
                    TextField("https://hooks.slack.com/services/…", text: urlBinding)
                        .textFieldStyle(WebhooksFieldStyle(focused: focus == .url, mono: true))
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .url)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .accessibilityLabel("URL")
                }

                formatField
                eventsField
                scopeField
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.sm)
            .padding(.bottom, ObSpace.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .obPage()
        .navigationTitle(initial == nil ? "보내는 웹훅 추가" : "웹훅 수정")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("취소") { dismiss() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WebhooksFooterBar {
                if let problem {
                    Text(problem)
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                        .transition(.opacity)
                }
                Button {
                    Task { await save() }
                } label: {
                    Text(saving ? "저장하는 중…" : initial == nil ? "만들기" : "저장")
                }
                .buttonStyle(.ob(.primary, fullWidth: true))
                .disabled(problem != nil || saving)
            }
            .animation(ObMotion.fast, value: problem)
        }
        .onAppear { if initial == nil { focus = .name } }
    }

    private var formatField: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(alignment: .firstTextBaseline) {
                WebhooksFieldLabel("보내는 형식")
                Spacer()
                if !formatTouched, !JS.trim(url).isEmpty {
                    Text("URL을 보고 골랐어요")
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
            }
            Picker("보내는 형식", selection: formatBinding) {
                ForEach(WEBHOOK_FORMATS, id: \.self) { f in
                    Text(f.label).tag(f)
                }
            }
            .pickerStyle(.segmented)
            WebhooksHelp(WEBHOOKS_FORMAT_HINT[format] ?? "")
        }
    }

    // MARK: events

    private var eventsField: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            WebhooksFieldLabel("보낼 이벤트")
            VStack(spacing: ObSpace.md) {
                ForEach(groups) { g in
                    group(g)
                }
            }
        }
    }

    private func group(_ g: WebhookEventGroup) -> some View {
        let all = g.events.allSatisfy { events.contains($0.key) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(g.label)
                    .font(ObFont.sub.weight(.semibold))
                    .foregroundStyle(Ob.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if g.events.count > 1 {
                    Button(all ? "모두 해제" : "모두 선택") {
                        Haptics.select()
                        withAnimation(ObMotion.fast) {
                            for e in g.events {
                                if all { events.remove(e.key) } else { events.insert(e.key) }
                            }
                        }
                    }
                    .font(ObFont.footnote.weight(.medium))
                    .foregroundStyle(Ob.text2)
                    .frame(minHeight: ObSize.row)
                    .contentShape(Rectangle())
                }
            }
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.row)

            ForEach(g.events) { e in
                Hairline().padding(.leading, ObSpace.md)
                WebhooksPickRow(on: events.contains(e.key), label: e.label, hint: e.hint) {
                    Haptics.select()
                    if events.contains(e.key) { events.remove(e.key) } else { events.insert(e.key) }
                }
            }

            if g.id == .schedule {
                Hairline()
                scheduleOptions
            }
        }
        .obCard(padding: 0, radius: ObRadius.lg)
    }

    private var scheduleOptions: some View {
        let leads = Array(Set(REMINDER_LEAD_OPTIONS + [remindMinutes])).sorted()
        return VStack(alignment: .leading, spacing: ObSpace.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: ObSpace.sm) {
                    Image(systemName: "clock").foregroundStyle(Ob.text3).accessibilityHidden(true)
                    Text("일정 알림 시각").font(ObFont.sub).foregroundStyle(Ob.text)
                    Spacer()
                    Picker("일정 알림 시각", selection: $alertHour) {
                        ForEach(0 ..< 24, id: \.self) { h in
                            Text(webhooksHourLabel(h)).tag(h)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .tint(Ob.text)
                }
                Text("매일 \(webhooksHourLabel(alertHour))부터 · 작업마다 하루 한 번 · \(zone(changed: initial.map { $0.alertHour != alertHour } ?? true))")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .disabled(!hasSchedule)
            .opacity(hasSchedule ? 1 : 0.45)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: ObSpace.sm) {
                    Image(systemName: "bell").foregroundStyle(Ob.text3).accessibilityHidden(true)
                    Text("시각 알림을 보낼 때").font(ObFont.sub).foregroundStyle(Ob.text)
                    Spacer()
                    Picker("시각 알림을 보낼 때", selection: $remindMinutes) {
                        ForEach(leads, id: \.self) { m in
                            Text(remindLeadLabel(m)).tag(m)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .tint(Ob.text)
                }
                Text("시각 알림은 \(remindLeadLabel(remindMinutes)) 보내요 · 시각이 정해진 작업만 · \(zone(changed: initial.map { $0.remindMinutes != remindMinutes } ?? true))")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .disabled(!hasReminder)
            .opacity(hasReminder ? 1 : 0.45)
        }
        .padding(.horizontal, ObSpace.md)
        .padding(.vertical, ObSpace.md)
        .animation(ObMotion.standard, value: hasSchedule)
        .animation(ObMotion.standard, value: hasReminder)
    }

    // MARK: projects

    private var scopeField: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            WebhooksFieldLabel("프로젝트 범위")
            Picker("프로젝트 범위", selection: $scope.animation(ObMotion.standard)) {
                Text("모든 프로젝트").tag(Scope.all)
                Text("고른 프로젝트만").tag(Scope.some)
            }
            .pickerStyle(.segmented)
            .disabled(store.projects.isEmpty && scope == .all)
            if scope == .some {
                VStack(spacing: 0) {
                    ForEach(Array(liveProjects.enumerated()), id: \.element.id) { i, p in
                        if i > 0 { Hairline().padding(.leading, ObSpace.md) }
                        WebhooksProjectPickRow(project: p, on: picked.contains(p.id)) {
                            Haptics.select()
                            if picked.contains(p.id) { picked.remove(p.id) } else { picked.insert(p.id) }
                        }
                    }
                }
                .obCard(padding: 0, radius: ObRadius.lg)
                .transition(.opacity)
            }
            WebhooksHelp(
                kind == .org
                    ? "프로젝트에 속하지 않은 작업(인박스)은 만든 사람과 담당자만 보는 비공개라 보내지 않아요. 멤버·팀·초대 이벤트는 범위와 상관없이 보내요."
                    : "개인 공간의 모든 작업이 대상이에요. 범위를 고르면 그 프로젝트의 작업만 보내요."
            )
        }
    }

    // MARK: save

    private func save() async {
        guard problem == nil, !saving else { return }
        saving = true
        focus = nil
        let order = liveProjects.map(\.id)
        let ids = order.filter(picked.contains) + picked.filter { !order.contains($0) }.sorted()
        let input = CreateWebhookInput(
            name: JS.trim(name),
            url: JS.trim(url),
            format: format,
            events: WEBHOOK_EVENT_KEYS.filter(events.contains),
            projectIds: .some(scope == .all ? nil : ids),
            alertHour: alertHour,
            remindMinutes: remindMinutes
        )
        guard let (hook, secret) = await model.saveOutgoing(initial, input) else {
            saving = false
            return
        }
        if let secret {
            Haptics.success()
            withAnimation(ObMotion.standard) {
                created = WebhooksRevealItem(kind: .secret(hook, secret), fresh: true)
            }
        } else {
            store.toasts.show("저장했어요")
            dismiss()
        }
    }
}

// MARK: - pieces

/// Pinned bottom bar of a 웹훅 sheet: hint + the main button (web Modal footer).
struct WebhooksFooterBar<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(spacing: ObSpace.sm) {
            content()
        }
        .padding(.horizontal, ObSpace.page)
        .padding(.top, ObSpace.md)
        .padding(.bottom, ObSpace.sm)
        .frame(maxWidth: .infinity)
        .background(Ob.bg)
        .overlay(alignment: .top) { Hairline() }
    }
}

/// Check row (web Pick): box, label, hint.
struct WebhooksPickRow: View {
    var on: Bool
    var label: String
    var hint: String?
    var toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: ObSpace.md) {
                WebhooksCheckbox(on: on)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(ObFont.sub)
                        .foregroundStyle(Ob.text)
                    if let hint {
                        Text(hint)
                            .font(ObFont.caption)
                            .foregroundStyle(Ob.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ObSpace.md)
            .padding(.vertical, 10)
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}

/// Project check row: box, swatch, name, 보관됨.
struct WebhooksProjectPickRow: View {
    var project: Project
    var on: Bool
    var toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: ObSpace.md) {
                WebhooksCheckbox(on: on)
                ProjectSwatch(color: project.color)
                Text(project.name)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                if project.archivedAt != nil {
                    Text("보관됨").font(ObFont.caption).foregroundStyle(Ob.text3)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ObSpace.md)
            .frame(minHeight: ObSize.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.obRow)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}
