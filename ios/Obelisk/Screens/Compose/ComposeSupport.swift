import SwiftUI

// Shared pieces of quick add (web components/QuickAdd.tsx): what each page passes to the composer,
// the parsed-token chips, Jev's triage suggestions and the syntax cheat-sheet. Used by `Composer`
// (the floating bar on list pages) and `NewTaskSheet` (the full form).

// MARK: - Page context

/// What the web passes to `<QuickAdd …>` on each page.
struct ComposeContext {
    /// `nil`: not chosen, so Jev may suggest one · `.some(nil)`: the inbox · `.some(id)`: that project.
    var projectId: String??
    /// Used when the text names no date.
    var defaultDueDate: ISODate?
    /// New tasks are assigned to this member (yourself on 내 작업).
    var defaultAssigneeId: String?
    var placeholder: String

    static let defaultPlaceholder = "할 일 추가 (예: 기획서 초안 내일 #업무 !높음)"

    /// The inline composer on a page (today, upcoming, mine, project, inbox, all; home uses the defaults).
    @MainActor
    static func composer(_ page: Page, _ store: AppStore) -> ComposeContext {
        var c = ComposeContext(projectId: nil, defaultDueDate: nil, defaultAssigneeId: nil, placeholder: defaultPlaceholder)
        switch page {
        case .inbox:
            c.projectId = .some(nil)
        case .today:
            c.defaultDueDate = store.today
            c.placeholder = "오늘 할 일 추가 (예: 견적서 보내기 !높음)"
        case .upcoming:
            c.defaultDueDate = addDays(store.today, 1)
            c.placeholder = "예정된 할 일 추가 (예: 치과 예약 다음 주 화요일)"
        case .mine:
            c.defaultAssigneeId = store.user?.id
            c.placeholder = "내가 맡을 작업 추가 (예: 계약서 검토 금요일 #법무)"
        case let .project(id):
            c.projectId = .some(id)
            if let p = store.project(id) { c.placeholder = "\(p.name)에 할 일 추가" }
        default:
            break
        }
        return c
    }

    /// Does a freshly created task show up in the list of `page`? When it doesn't, we say where it went.
    @MainActor
    static func shows(_ t: TaskItem, on page: Page, _ store: AppStore) -> Bool {
        switch page {
        case .inbox: t.projectId == nil
        case .today: isToday(t, store.today)
        case .upcoming: matchesView(t, .upcoming, store.today)
        case .mine: t.assigneeId != nil && t.assigneeId == store.user?.id
        case .all: true
        case let .project(id): t.projectId == id
        default: false
        }
    }
}

extension String {
    var composeTrimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - Parsed-token chips

enum ComposeChipTone {
    case info, outline, danger, warn, secondary
    /// The default date: dashed, not removable.
    case dashed

    var foreground: Color {
        switch self {
        case .info: ProjectColor.blue.palette.text
        case .danger: ProjectColor.red.palette.text
        case .warn: ProjectColor.orange.palette.text
        case .secondary: ProjectColor.slate.palette.text
        case .outline: Ob.text
        case .dashed: Ob.text2
        }
    }

    var background: Color {
        switch self {
        case .info: ProjectColor.blue.palette.bg
        case .danger: ProjectColor.red.palette.bg
        case .warn: ProjectColor.orange.palette.bg
        case .secondary: ProjectColor.slate.palette.bg
        case .outline, .dashed: .clear
        }
    }
}

struct ComposeChipModel: Identifiable {
    var id: String
    /// nil for the default-date chip (it can't be cancelled).
    var kind: QuickAddKind?
    var symbol: String
    var text: String
    var note: String?
    var tone: ComposeChipTone
    /// Project colour (shown instead of the symbol).
    var dot: Color?
}

enum ComposeParse {
    /// "목요일" alone is ambiguous: always pair relative words with the actual date.
    static func dateText(_ d: ISODate, _ today: ISODate) -> String {
        let rel = formatRelativeKo(d, today)
        if rel.contains("월") { return rel }
        let short = formatShortKo(d).replacingOccurrences(of: " \\(.\\)$", with: "", options: .regularExpression)
        return "\(rel) · \(short)"
    }

    /// One chip per recognised token, with the web's labels and tones.
    static func chips(_ parsed: QuickAddResult, today: ISODate, matched: Project?) -> [ComposeChipModel] {
        parsed.tokens.enumerated().map { i, t in
            let id = "\(t.kind.rawValue)-\(i)"
            switch t.kind {
            case .date:
                let parts = t.value.components(separatedBy: "~")
                let text = parts.count > 1
                    ? "\(dateText(parts[0], today)) → \(dateText(parts[1], today))"
                    : dateText(parts[0], today)
                return ComposeChipModel(id: id, kind: .date, symbol: "calendar", text: text, tone: .info)
            case .time:
                let parts = t.value.components(separatedBy: "~")
                let time = parts.count > 1 ? formatTimeRangeKo(parts[0], parts[1]) : formatTimeKo(parts[0])
                // A time typed without a date lands on today or tomorrow: say which.
                let day = !parsed.tokens.contains(where: { $0.kind == .date }) && parsed.dueDate != nil
                    ? "\(formatRelativeKo(parsed.dueDate!, today)) " : ""
                return ComposeChipModel(id: id, kind: .time, symbol: "clock", text: "\(day)\(time)", tone: .info)
            case .project:
                return ComposeChipModel(
                    id: id, kind: .project, symbol: "number",
                    text: matched?.name ?? "새 프로젝트 “\(t.value)”", tone: .outline,
                    dot: matched?.color.palette.ink
                )
            case .priority:
                let p = Int(t.value) ?? 0
                return ComposeChipModel(
                    id: id, kind: .priority, symbol: "flag",
                    text: "우선순위 \(PriorityInfo.labelKo[p] ?? "")",
                    tone: p == 3 ? .danger : p == 2 ? .warn : .secondary
                )
            case .fixed:
                return ComposeChipModel(id: id, kind: .fixed, symbol: "pin", text: "고정 일정", tone: .outline)
            case .estimate:
                return ComposeChipModel(id: id, kind: .estimate, symbol: "hourglass", text: "예상 \(formatDurationKo(Int(t.value) ?? 0))", tone: .outline)
            }
        }
    }

    /// The dashed "기본" chip: the date a task gets when the text names none.
    static func defaultDateChip(_ date: ISODate, today: ISODate) -> ComposeChipModel {
        ComposeChipModel(id: "default", kind: nil, symbol: "calendar", text: formatRelativeKo(date, today), note: "기본", tone: .dashed)
    }

    /// Remove the words of `tokens` from `text` (a field now holds what they said).
    static func strip(_ text: String, _ tokens: [QuickAddToken]) -> String {
        var words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        for t in tokens {
            let tw = t.text.split(whereSeparator: \.isWhitespace).map(String.init)
            guard !tw.isEmpty, tw.count <= words.count else { continue }
            for i in 0 ... (words.count - tw.count) where Array(words[i ..< i + tw.count]) == tw {
                words.removeSubrange(i ..< i + tw.count)
                break
            }
        }
        return words.joined(separator: " ")
    }

    /// Minutes past midnight now, when the user's today is the clock's today ("3시" alone means the next 3 o'clock).
    @MainActor
    static func nowMinutes(_ store: AppStore) -> Int? {
        let clock = nowIn(store.timezone)
        return clock.date == store.today ? clock.minutes : nil
    }

    /// "내일 · 11/20 · 오후 3:00", "11월 20일 (목)"
    static func whenText(_ date: ISODate, _ time: ISOTime?, today: ISODate) -> String {
        let d = dateText(date, today)
        guard let time else { return d }
        return "\(d) · \(formatTimeKo(time))"
    }
}

/// One parsed token (web .chip badge): tap to cancel recognition and keep the words in the title.
struct ComposeChip: View {
    var chip: ComposeChipModel
    var onRemove: (() -> Void)?

    var body: some View {
        if let onRemove {
            Button(action: onRemove) { content }
                .buttonStyle(.plain)
                .contentShape(Rectangle().inset(by: -8))
                .accessibilityLabel("\(chip.text) 인식 취소")
                .accessibilityHint("누르면 인식을 취소하고 제목에 그대로 둬요")
        } else {
            content
                .accessibilityElement(children: .combine)
                .accessibilityHint("날짜를 적지 않으면 이 날짜로 들어가요")
        }
    }

    private var content: some View {
        HStack(spacing: 4) {
            if let dot = chip.dot {
                Circle().fill(dot).frame(width: 7, height: 7)
            } else {
                Image(systemName: chip.symbol).font(.system(size: 10.5, weight: .medium))
            }
            Text(chip.text).lineLimit(1)
            if let note = chip.note {
                Text(note).fontWeight(.regular).foregroundStyle(Ob.text3)
            }
            if onRemove != nil {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .opacity(0.55)
            }
        }
        .font(ObFont.caption.weight(.medium))
        .foregroundStyle(chip.tone.foreground)
        .padding(.leading, 8)
        .padding(.trailing, onRemove != nil ? 7 : 8)
        .frame(height: 26)
        .background(chip.tone.background, in: RoundedRectangle(cornerRadius: ObRadius.xs))
        .overlay {
            switch chip.tone {
            case .outline:
                RoundedRectangle(cornerRadius: ObRadius.xs).strokeBorder(Ob.borderStrong, lineWidth: 1)
            case .dashed:
                RoundedRectangle(cornerRadius: ObRadius.xs)
                    .strokeBorder(Ob.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            default:
                EmptyView()
            }
        }
        .fixedSize()
    }
}

// MARK: - Jev triage (project / priority / fixed for what the text leaves open)

enum ComposeJevKind: String, Hashable, CaseIterable {
    case project, priority, fixed
}

struct ComposeJevOffer: Identifiable {
    var kind: ComposeJevKind
    var text: String
    var confidence: Double
    var color: Color?
    var id: ComposeJevKind { kind }

    var symbol: String { kind == .fixed ? "pin" : "flag" }
}

/// One debounced POST /api/jev/triage per change of what Jev looks at (web QuickAdd's effect).
@Observable
@MainActor
final class ComposeJevState {
    private(set) var key: String?
    private(set) var suggestion: TriageSuggestion?
    var accepted: Set<ComposeJevKind> = []
    private(set) var asking = false

    /// The suggestion for exactly this text, if there is one.
    func live(_ key: String, title: String) -> TriageSuggestion? {
        self.key == key && title.count >= 2 ? suggestion : nil
    }

    func reset() {
        key = nil
        suggestion = nil
        accepted = []
        asking = false
    }

    func toggle(_ k: ComposeJevKind) {
        if accepted.contains(k) { accepted.remove(k) } else { accepted.insert(k) }
    }

    /// Run from `.task(id: key)`: waits 450 ms, asks, and pre-accepts confident answers when auto-apply is on.
    /// `projectId`: `nil` lets Jev pick a project; `.some(nil)` means the inbox was chosen.
    func run(key: String, title: String, startDate: ISODate?, dueDate: ISODate?, projectId: String??, connected: Bool, autoApply: Bool) async {
        guard connected, title.count >= 2 else {
            asking = false
            return
        }
        if self.key == key, suggestion != nil { return }
        do {
            try await Task.sleep(for: .milliseconds(450))
        } catch {
            return
        }
        asking = true
        defer { if !Task.isCancelled { asking = false } }
        var body: [String: JSONValue] = [
            "title": .string(title),
            "startDate": .orNull(startDate),
            "dueDate": .orNull(dueDate),
        ]
        if let projectId { body["projectId"] = .orNull(projectId) }
        do {
            let r: JevTriageResponse = try await API.shared.send(.post, "/api/jev/triage", json: .object(body))
            guard !Task.isCancelled else { return }
            self.key = key
            suggestion = r.suggestion
            var pre = Set<ComposeJevKind>()
            if autoApply {
                let s = r.suggestion
                if let p = s.project, p.id != nil, p.confidence >= JEV_CONFIDENT { pre.insert(.project) }
                if s.priority.value > 0, s.priority.confidence >= JEV_CONFIDENT { pre.insert(.priority) }
                if s.fixed.value, s.fixed.probability >= 0.85 { pre.insert(.fixed) }
            }
            accepted = pre
        } catch {
            // Triage is a hint: a failed call just shows nothing.
        }
    }
}

/// "Jev" label + suggestion chips (dashed until taken, filled with a check once taken).
struct ComposeJevRow: View {
    var offers: [ComposeJevOffer]
    var asking: Bool
    var isOn: (ComposeJevKind) -> Bool
    var onToggle: (ComposeJevKind) -> Void
    var onTakeAll: () -> Void

    var body: some View {
        FlowRow(spacing: 6, lineSpacing: 6) {
            HStack(spacing: 4) {
                if asking {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "scalemass").font(.system(size: 11, weight: .medium))
                }
                Text("Jev")
            }
            .font(ObFont.caption.weight(.semibold))
            .foregroundStyle(Ob.text2)
            .frame(height: 26)
            .padding(.trailing, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(asking ? "Jev가 살펴보는 중" : "Jev 제안")

            ForEach(offers) { o in
                let on = isOn(o.kind)
                Button {
                    Haptics.select()
                    onToggle(o.kind)
                } label: {
                    HStack(spacing: 4) {
                        if let c = o.color {
                            Circle().fill(c).frame(width: 7, height: 7)
                        } else {
                            Image(systemName: o.symbol).font(.system(size: 10.5, weight: .medium))
                        }
                        Text(o.text).lineLimit(1)
                        Image(systemName: on ? "checkmark" : "plus")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .font(ObFont.caption.weight(.medium))
                    .foregroundStyle(on ? Ob.text : Ob.text2)
                    .padding(.leading, 8)
                    .padding(.trailing, 7)
                    .frame(height: 26)
                    .background(on ? Ob.surface3 : .clear, in: RoundedRectangle(cornerRadius: ObRadius.xs))
                    .overlay {
                        if !on {
                            RoundedRectangle(cornerRadius: ObRadius.xs)
                                .strokeBorder(Ob.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        }
                    }
                    .fixedSize()
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle().inset(by: -8))
                .accessibilityLabel(o.text)
                .accessibilityValue(on ? "적용됨" : "")
                .accessibilityHint(on ? "누르면 제안을 빼요" : "누르면 적용해요 · 확신 \(Int((o.confidence * 100).rounded()))%")
            }

            if offers.contains(where: { !isOn($0.kind) }) {
                Button("모두 적용") {
                    Haptics.select()
                    onTakeAll()
                }
                .font(ObFont.caption.weight(.medium))
                .foregroundStyle(Ob.text3)
                .buttonStyle(.plain)
                .padding(.horizontal, 4)
                .frame(height: 26)
                .contentShape(Rectangle().inset(by: -8))
            }
        }
        .animation(ObMotion.standard, value: offers.map(\.kind))
    }
}

// MARK: - Syntax cheat-sheet (web SyntaxHelp)

struct ComposeSyntaxHelp: View {
    /// Where the parsed chips sit relative to the field ("위" in the composer, "아래" in the sheet).
    var chipsAbove = false
    var onClose: (() -> Void)?

    private struct Row: Identifiable {
        var symbol: String
        var label: String
        var codes: [String]
        var note: String?
        var id: String { label }
    }

    private let rows: [Row] = [
        Row(symbol: "calendar", label: "날짜", codes: ["오늘", "내일", "금요일", "다음 주 수요일", "11/20", "3일 후", "11/20~11/22"]),
        Row(symbol: "clock", label: "시각", codes: ["오후 3시", "15:30", "3시 반", "10시~11시"], note: "날짜 없이 쓰면 다가오는 그 시각"),
        Row(symbol: "number", label: "프로젝트", codes: ["#업무"], note: "없는 이름이면 새로 만들어요"),
        Row(symbol: "flag", label: "우선순위", codes: ["!높음", "!보통", "!낮음"]),
        Row(symbol: "pin", label: "고정 일정", codes: ["@고정"], note: "움직이지 않는 약속·마감"),
        Row(symbol: "hourglass", label: "예상 시간", codes: ["~30분", "~1h", "~1시간 30분"], note: "하루 계획과 완료 확률에 쓰여요"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let onClose {
                HStack {
                    Text("이렇게 적으면 알아서 정리돼요")
                        .font(ObFont.footnote.weight(.semibold))
                        .foregroundStyle(Ob.text)
                    Spacer(minLength: ObSpace.sm)
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Ob.text3)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("도움말 닫기")
                    .padding(.trailing, -8)
                }
                .padding(.top, -4)
            }
            ForEach(rows) { r in
                VStack(alignment: .leading, spacing: 5) {
                    Label {
                        Text(r.label)
                    } icon: {
                        Image(systemName: r.symbol).foregroundStyle(Ob.text3)
                    }
                    .labelStyle(ComposeTightLabelStyle())
                    .font(ObFont.caption.weight(.medium))
                    .foregroundStyle(Ob.text2)
                    FlowRow(spacing: 4, lineSpacing: 4) {
                        ForEach(r.codes, id: \.self) { ComposeCode(text: $0) }
                    }
                    if let note = r.note {
                        Text(note)
                            .font(ObFont.caption)
                            .foregroundStyle(Ob.text3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
            VStack(alignment: .leading, spacing: 6) {
                Hairline()
                    .padding(.bottom, 4)
                HStack(spacing: 6) {
                    Text("예:").font(ObFont.caption).foregroundStyle(Ob.text3)
                    ComposeCode(text: "기획서 초안 내일 오후 3시 #업무 !높음")
                }
                Text("입력창 \(chipsAbove ? "위에" : "아래에") 뜬 항목을 누르면 인식을 취소해요")
                    .font(ObFont.caption)
                    .foregroundStyle(Ob.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct ComposeCode: View {
    var text: String
    var body: some View {
        Text(text)
            .font(ObFont.caption)
            .foregroundStyle(Ob.text)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(height: 22)
            .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.xs))
            .overlay(RoundedRectangle(cornerRadius: ObRadius.xs).strokeBorder(Ob.border, lineWidth: 1))
            .fixedSize()
    }
}

struct ComposeTightLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon
            configuration.title
        }
    }
}
