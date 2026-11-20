import SwiftUI

/// 서버 관리 › 공지 (web admin/notice): a banner over everyone's app, and a mail to everyone.
struct AdminNoticeTab: View {
    var reload: Int

    @Environment(AppStore.self) private var store
    @State private var settings: ServerSettings?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if let error { AdminErrorCallout(message: error) }
            if let st = settings {
                AdminBannerSection(settings: st) { settings = $0 }
                AdminMailAllSection(settings: st)
            } else if error == nil {
                AdminLoading(height: 200)
            }
        }
        .task(id: reload) {
            do {
                settings = try await API.shared.get("/api/admin/settings")
                error = nil
            } catch is CancellationError {
            } catch {
                if settings == nil { self.error = (error as? LocalizedError)?.errorDescription ?? "불러오지 못했어요" }
            }
        }
    }
}

// MARK: - 공지 배너

struct AdminBannerSection: View {
    var settings: ServerSettings
    var onSaved: (ServerSettings) -> Void

    @Environment(AppStore.self) private var store
    @State private var text = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    private var current: String { settings.announcement?.text ?? "" }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        OrgSection(
            "공지 배너",
            lead: settings.announcement.map {
                "\(AdminDates.dateTime($0.at))부터 모든 화면 위에 보이고 있어요. 사용자가 닫으면 그 기기에서는 다시 보이지 않고, 내용을 바꾸면 다시 보여요."
            } ?? "모든 사용자의 화면 맨 위에 한 줄로 보여요. 사용자는 닫을 수 있어요."
        ) {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                TextField("예: 11월 21일(금) 밤 11시부터 10분 동안 점검해요.", text: $text, axis: .vertical)
                    .lineLimit(3 ... 6)
                    .font(ObFont.body)
                    .focused($focused)
                    .padding(ObSpace.md)
                    .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(focused ? Ob.text3 : Ob.input, lineWidth: 1))
                    .onChange(of: text) { _, v in if v.count > 300 { text = String(v.prefix(300)) } }
                    .accessibilityLabel("공지 내용")
                if !trimmed.isEmpty {
                    // What everyone will see (the same line NoticeBanner draws).
                    HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                        Image(systemName: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(Ob.text2)
                        Text(trimmed)
                            .font(ObFont.sub)
                            .foregroundStyle(Ob.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, ObSpace.md)
                    .padding(.vertical, 10)
                    .background(Ob.tint, in: RoundedRectangle(cornerRadius: ObRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(Ob.border, lineWidth: 1))
                    .accessibilityLabel("미리보기: \(trimmed)")
                    .transition(.opacity)
                }
                HStack(spacing: ObSpace.sm) {
                    Text("\(text.count) / 300")
                        .font(ObFont.footnote.monospacedDigit())
                        .foregroundStyle(Ob.text3)
                    Spacer(minLength: 0)
                    if settings.announcement != nil {
                        Button("내리기") { Task { await put("") } }
                            .buttonStyle(.ob(.outline, size: .small))
                            .disabled(busy)
                    }
                    Button(settings.announcement != nil ? "바꿔 올리기" : "올리기") { Task { await put(trimmed) } }
                        .buttonStyle(.ob(.primary, size: .small))
                        .disabled(busy || trimmed.isEmpty || trimmed == current)
                }
            }
            .animation(ObMotion.standard, value: trimmed.isEmpty)
        }
        .onAppear { text = current }
        .onChange(of: current) { _, v in text = v }
    }

    private func put(_ value: String) async {
        focused = false
        busy = true
        defer { busy = false }
        do {
            let s: ServerSettings = try await API.shared.send(.put, "/api/admin/announcement", json: ["text": .string(value)])
            onSaved(s)
            await store.refresh()
            Haptics.success()
            store.toasts.show(value.isEmpty ? "공지를 내렸어요" : "공지를 올렸어요")
        } catch {
            store.adminFailed(error, "공지를 바꾸지 못했어요")
        }
    }
}

// MARK: - 전체 메일

struct AdminMailAllSection: View {
    var settings: ServerSettings

    @Environment(AppStore.self) private var store
    @State private var audience = "all"
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var job: AdminMailJob?
    @State private var recipients: Int?
    @State private var confirming = false
    @State private var busy = false
    @FocusState private var focus: Field?

    enum Field { case subject, body }

    private var running: Bool { job.map { !$0.done } ?? false }
    private var disabled: Bool { !settings.mailAvailable }

    var body: some View {
        OrgSection(
            "전체 메일",
            lead: disabled
                ? "SMTP_URL이 설정되지 않아 메일을 보낼 수 없어요."
                : "정지되지 않고 가입이 끝난 계정에 한 통씩 보내요. 메일함 SMTP는 하루 보내기 한도가 있으니 사용자가 많으면 나눠 보내세요."
                + (settings.mailToLog ? " 개발 모드라 메일은 백엔드 로그에 찍혀요." : "")
        ) {
            VStack(alignment: .leading, spacing: ObSpace.md) {
                if let job { jobCard(job) }
                Picker("받는 사람", selection: $audience) {
                    Text("모든 사용자").tag("all")
                    Text("메일 확인된 주소만").tag("verified")
                }
                .pickerStyle(.segmented)
                VStack(alignment: .leading, spacing: 6) {
                    Text("제목").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                    TextField("", text: $subject)
                        .textFieldStyle(.ob(focused: focus == .subject))
                        .focused($focus, equals: .subject)
                        .submitLabel(.next)
                        .onSubmit { focus = .body }
                        .onChange(of: subject) { _, v in if v.count > 120 { subject = String(v.prefix(120)) } }
                        .disabled(disabled)
                        .accessibilityLabel("제목")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("내용").font(ObFont.footnote.weight(.medium)).foregroundStyle(Ob.text2)
                    TextField("빈 줄로 문단을 나눠요.", text: $bodyText, axis: .vertical)
                        .lineLimit(6 ... 14)
                        .font(ObFont.body)
                        .focused($focus, equals: .body)
                        .padding(ObSpace.md)
                        .background(Ob.bg, in: RoundedRectangle(cornerRadius: ObRadius.md))
                        .overlay(RoundedRectangle(cornerRadius: ObRadius.md).strokeBorder(focus == .body ? Ob.text3 : Ob.input, lineWidth: 1))
                        .onChange(of: bodyText) { _, v in if v.count > 5000 { bodyText = String(v.prefix(5000)) } }
                        .disabled(disabled)
                        .accessibilityLabel("내용")
                }
                HStack {
                    Text(recipients.map { "받는 사람 \(formatCount($0))명" } ?? "")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                    Spacer(minLength: 0)
                    Button("보내기") {
                        focus = nil
                        confirming = true
                    }
                    .buttonStyle(.ob(.primary, size: .small))
                    .disabled(disabled || running || busy || subject.trimmingCharacters(in: .whitespaces).isEmpty
                        || bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (recipients ?? 0) == 0)
                }
            }
        }
        .task(id: audience) { await poll() }
        // While a job runs, follow it.
        .task(id: running ? job?.id : nil) {
            guard running else { return }
            while !Task.isCancelled, running {
                try? await Task.sleep(for: .seconds(1.5))
                if Task.isCancelled { break }
                await poll()
            }
        }
        .confirmationDialog(
            "\(formatCount(recipients ?? 0))명에게 보낼까요?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("보내기") { Task { await send() } }
            Button("취소", role: .cancel) {}
        } message: {
            Text("‘\(subject.trimmingCharacters(in: .whitespaces))’ 메일을 \(audience == "verified" ? "메일을 확인한 " : "")사용자에게 한 통씩 보내요. 보낸 메일은 되돌릴 수 없어요.")
        }
    }

    private func jobCard(_ job: AdminMailJob) -> some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            HStack(spacing: ObSpace.sm) {
                Text(job.subject)
                    .font(ObFont.bodyStrong)
                    .foregroundStyle(Ob.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !job.done {
                    Button("멈추기") { Task { await stop() } }
                        .buttonStyle(.ob(.outline, size: .small))
                } else if let at = job.finishedAt {
                    Text(AdminDates.dateTime(at))
                        .font(ObFont.caption)
                        .foregroundStyle(Ob.text3)
                }
            }
            ProgressView(value: Double(job.sent + job.failed), total: Double(max(job.total, 1)))
                .tint(Ob.text)
                .accessibilityLabel("보낸 메일")
            Text("\(job.done ? "끝" : "보내는 중") · \(formatCount(job.sent)) / \(formatCount(job.total))명\(job.failed > 0 ? " · 실패 \(formatCount(job.failed))" : "") · \(job.startedBy)")
                .font(ObFont.footnote.monospacedDigit())
                .foregroundStyle(Ob.text3)
        }
        .padding(ObSpace.lg)
        .overlay(RoundedRectangle(cornerRadius: ObRadius.lg).strokeBorder(Ob.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func poll() async {
        struct R: Decodable { var job: AdminMailJob?; var recipients: Int }
        guard let r: R = try? await API.shared.get("/api/admin/mail", query: ["audience": audience]) else { return }
        job = r.job
        recipients = r.recipients
    }

    private func send() async {
        struct R: Decodable { var job: AdminMailJob }
        busy = true
        defer { busy = false }
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/mail", json: [
                "subject": .string(subject.trimmingCharacters(in: .whitespaces)),
                "body": .string(bodyText.trimmingCharacters(in: .whitespacesAndNewlines)),
                "audience": .string(audience),
            ])
            job = r.job
            subject = ""
            bodyText = ""
            Haptics.success()
            store.toasts.show("\(formatCount(r.job.total))명에게 보내기 시작했어요")
        } catch {
            store.adminFailed(error, "보내지 못했어요")
        }
    }

    private func stop() async {
        struct R: Decodable { var job: AdminMailJob? }
        do {
            let r: R = try await API.shared.send(.post, "/api/admin/mail/stop")
            job = r.job
        } catch {
            store.adminFailed(error, "멈추지 못했어요")
        }
    }
}
