import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Obelisk에 추가" in the share sheet: text or a link from any app becomes a task.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let root = ShareComposeView(
            model: model,
            close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: NSError(domain: "dev.lxvu.obelisk.share", code: NSUserCancelledError))
            }
        )
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items) }
    }
}

@Observable
@MainActor
final class ShareModel {
    var title = ""
    var link: URL?
    var extraText = ""
    /// nil = not chosen (a #project in the title can pick one); .some(nil) = 인박스.
    var projectChoice: String?? = nil
    var busy = false
    var error: String?
    var added: QuickCreate.Result?
    var loaded = false

    let snapshot = Snapshot.load()
    var signedIn: Bool { Session.isSignedIn }
    var projects: [Project] { snapshot?.writableProjects ?? [] }

    func load(_ items: [NSExtensionItem]) async {
        var texts: [String] = []
        var pageTitle: String?
        for item in items {
            if let t = item.attributedContentText?.string, !t.isEmpty { pageTitle = pageTitle ?? t }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    if link == nil, url.scheme?.hasPrefix("http") == true { link = url }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let url = URL(string: trimmed), url.scheme?.hasPrefix("http") == true, !trimmed.contains(" ") {
                        if link == nil { link = url }
                    } else if !trimmed.isEmpty {
                        texts.append(trimmed)
                    }
                }
            }
        }
        // The first line of shared text, else the page title, becomes the title; the rest goes to the notes.
        let all = texts.joined(separator: "\n")
        let lines = all.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        if let first = lines.first {
            title = String(first.prefix(200))
            extraText = lines.dropFirst().joined(separator: "\n")
        } else if let pageTitle {
            title = String(pageTitle.prefix(200))
        } else if let host = link?.host() {
            title = host
        }
        loaded = true
    }

    /// What the title will be understood as ("내일 오후 3:00 · 블로그"), live as it's edited.
    var understood: String {
        guard let s = snapshot else { return "" }
        let now = clockNow(s.timezone)
        let p = parseQuickAdd(title, now.date, nowMinutes: now.minutes)
        var parts: [String] = []
        if let d = p.dueDate ?? p.startDate {
            parts.append(withTime(formatRelativeKo(d, now.date), p.dueDate != nil ? p.dueTime : p.startTime))
        }
        if let pr = p.priority, pr > 0, let label = PriorityInfo.labelKo[pr] { parts.append("우선순위 \(label)") }
        if projectChoice == nil, let name = p.projectName, let match = matchProject(projects, name) { parts.append(match.name) }
        return parts.joined(separator: " · ")
    }

    var projectLabel: String {
        switch projectChoice {
        case .none: "자동 (#프로젝트 또는 인박스)"
        case .some(.none): "인박스"
        case let .some(.some(id)): projects.first { $0.id == id }?.name ?? "인박스"
        }
    }

    var notes: String {
        [extraText, link?.absoluteString ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    func add() async -> Bool {
        guard !busy else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            added = try await QuickCreate.create(title, notes: notes, projectId: projectChoice)
            return true
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "추가하지 못했어요"
            return false
        }
    }
}

struct ShareComposeView: View {
    @Bindable var model: ShareModel
    var close: () -> Void
    var cancel: () -> Void
    @FocusState private var titleFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if !model.signedIn {
                    VStack(spacing: ObSpace.md) {
                        Image("Logo").resizable().renderingMode(.template).frame(width: 28, height: 28).foregroundStyle(Ob.text)
                        Text("Obelisk 앱에서 먼저 로그인하세요")
                            .font(ObFont.body)
                            .foregroundStyle(Ob.text2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let added = model.added {
                    VStack(spacing: ObSpace.sm) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 32))
                            .foregroundStyle(Ob.ok)
                        Text("“\(added.task.title)” 추가했어요")
                            .font(ObFont.bodyStrong)
                            .foregroundStyle(Ob.text)
                            .multilineTextAlignment(.center)
                        if !added.summary.isEmpty {
                            Text(added.summary).font(ObFont.sub).foregroundStyle(Ob.text3)
                        }
                    }
                    .padding(ObSpace.xxl)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task {
                        try? await Task.sleep(for: .milliseconds(900))
                        close()
                    }
                } else {
                    form
                }
            }
            .background(Ob.bg.ignoresSafeArea())
            .navigationTitle("Obelisk에 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소", action: cancel)
                }
                if model.signedIn, model.added == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("추가") {
                            Task {
                                if await model.add() {
                                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                                }
                            }
                        }
                        .fontWeight(.semibold)
                        .disabled(model.busy || model.title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .tint(Ob.primary)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ObSpace.lg) {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("할 일 (예: 읽어 보기 내일 #블로그)", text: $model.title, axis: .vertical)
                        .font(ObFont.body)
                        .lineLimit(1 ... 4)
                        .focused($titleFocused)
                        .padding(ObSpace.md)
                        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(titleFocused ? Ob.text3 : Ob.input, lineWidth: 1))
                    if !model.understood.isEmpty {
                        Text(model.understood)
                            .font(ObFont.footnote)
                            .foregroundStyle(Ob.infoText)
                    }
                }

                VStack(spacing: 0) {
                    Menu {
                        Button("자동 (#프로젝트 또는 인박스)") { model.projectChoice = nil }
                        Button("인박스") { model.projectChoice = .some(nil) }
                        if !model.projects.isEmpty {
                            Divider()
                            ForEach(model.projects) { p in
                                Button(p.name) { model.projectChoice = .some(p.id) }
                            }
                        }
                    } label: {
                        HStack {
                            Label("프로젝트", systemImage: "folder")
                                .foregroundStyle(Ob.text2)
                            Spacer()
                            Text(model.projectLabel)
                                .foregroundStyle(Ob.text)
                                .lineLimit(1)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11))
                                .foregroundStyle(Ob.text3)
                        }
                        .font(ObFont.body)
                        .frame(minHeight: ObSize.row)
                    }
                    if let link = model.link {
                        Rectangle().fill(Ob.border).frame(height: 1)
                        HStack(spacing: ObSpace.sm) {
                            Image(systemName: "link").foregroundStyle(Ob.text3)
                            Text(link.absoluteString)
                                .font(ObFont.footnote)
                                .foregroundStyle(Ob.text2)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: ObSize.row)
                    }
                }
                .padding(.horizontal, ObSpace.md)
                .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))

                if let error = model.error {
                    Text(error).font(ObFont.sub).foregroundStyle(Ob.dangerText)
                }

                if let ws = model.snapshot?.workspace.name {
                    Text("\(ws)에 추가돼요. 링크와 나머지 글은 메모로 들어가요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
            }
            .padding(ObSpace.lg)
        }
        .onAppear { titleFocused = true }
    }
}
