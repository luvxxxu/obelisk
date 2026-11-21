import Foundation

// Port of packages/core/test/jev.test.ts and webhooks.test.ts.

private let JEV_TODAY = "2026-11-16"
private var jevSeq = 0

private func jt(_ id: String, status: TaskStatus = .todo, startDate: String? = nil, dueDate: String? = nil, fixed: Bool = false, assigneeIds: [String] = []) -> TaskItem {
    jevSeq += 1
    return makeTask(id: id, number: jevSeq, status: status, startDate: startDate, dueDate: dueDate, fixed: fixed, position: Double(jevSeq), assigneeIds: assigneeIds)
}

private func J(_ importance: Double, _ deferrable: Double = 0.5, _ others: Double = 0.2, _ importanceConfidence: Double = 0.95) -> TaskJudgment {
    TaskJudgment(importance: importance, importanceConfidence: importanceConfidence, others: others, deferrable: deferrable)
}

func runJevTests() {
    describe("urgency") {
        test("grows as the due date nears and saturates once overdue") {
            func at(_ dueDate: String) -> Urgency { urgencyOf(makeTask(dueDate: dueDate), JEV_TODAY) }
            expectEqual(at("2026-11-14"), Urgency(value: 1, days: -2, label: "2일 지남"))
            expectEqual(at("2026-11-16").label, "오늘 마감")
            expectTrue(at("2026-11-17").value > at("2026-11-20").value)
            expectTrue(at("2026-12-20").value < 0.2)
        }

        test("a fixed commitment this week counts as urgent") {
            let u = urgencyOf(makeTask(startDate: "2026-11-20", fixed: true), JEV_TODAY)
            expectTrue(u.value >= 0.6)
        }
    }

    describe("priority (Jev importance × engine urgency)") {
        test("high stakes due today → 높음, desk tidying due today → 낮음") {
            let tax = suggestPriority(jt("tax", dueDate: JEV_TODAY), J(2.95), nil, JEV_TODAY)
            let desk = suggestPriority(jt("desk", dueDate: JEV_TODAY), J(0.99), nil, JEV_TODAY)
            expectEqual(tax.suggested, 3)
            expectEqual(desk.suggested, 1)
            expectEqual(tax.reasons[0], "놓치면 손해가 큰 일")
            expectTrue(tax.reasons.contains("오늘 마감"))
        }

        test("an important task far away is 보통 until its date nears") {
            expectEqual(suggestPriority(jt("far", dueDate: "2026-12-08"), J(3), nil, JEV_TODAY).suggested, 2)
            expectEqual(suggestPriority(jt("near", dueDate: "2026-11-17"), J(3), nil, JEV_TODAY).suggested, 3)
        }

        test("someday ideas get no priority; blocking work gets a bump") {
            expectEqual(suggestPriority(jt("idea"), J(0.2), nil, JEV_TODAY).suggested, 0)
            let lev = TaskLeverage(taskId: "x", downstreamCount: 3, slackDays: 0, delayedIfLate: 2, conflictsIfLate: 1)
            expectTrue(priorityScore(J(2), 0.5, 1) > priorityScore(J(2), 0.5, 0))
            let s = suggestPriority(jt("x", dueDate: "2026-11-20"), J(2), lev, JEV_TODAY)
            expectTrue(s.reasons.contains("하루 늦으면 고정 일정과 충돌"))
            expectEqual(priorityFromScore(s.score), s.suggested)
        }

        test("confidence drops on a cut point and auto-apply only fills missing priorities") {
            let sure = suggestPriority(jt("a", dueDate: JEV_TODAY), J(2.95, 0.5, 0.2, 0.97), nil, JEV_TODAY)
            expectTrue(sure.confidence > 0.8)
            expectTrue(autoApplicable(sure))
            var picked = sure
            picked.current = 1
            expectFalse(autoApplicable(picked))
            let unsure = suggestPriority(jt("b", dueDate: JEV_TODAY), J(2.95, 0.5, 0.2, 0.5), nil, JEV_TODAY)
            expectFalse(autoApplicable(unsure))
        }
    }

    describe("focus") {
        test("picks the best startable task for today; blocked work waits") {
            let a = jt("a", dueDate: JEV_TODAY)
            let b = jt("b", dueDate: JEV_TODAY)
            let c = jt("c", dueDate: "2026-11-25")
            let scores = ["a": 0.5, "b": 0.9, "c": 0.99]
            expectEqual(pickFocus([a, b, c], [], scores, JEV_TODAY), "b")
            expectEqual(pickFocus([a, b, c], [PlanDependency(taskId: "b", dependsOnId: "a")], scores, JEV_TODAY), "a")
        }

        test("in-progress work wins a near tie") {
            let a = jt("a", status: .doing, dueDate: JEV_TODAY)
            let b = jt("b", dueDate: JEV_TODAY)
            expectEqual(pickFocus([a, b], [], ["a": 0.6, "b": 0.63], JEV_TODAY), "a")
        }
    }

    describe("what to postpone") {
        let yes: (TaskItem) -> Bool = { _ in true }

        test("an overloaded day sheds the tasks Jev says can wait, onto lighter days") {
            let tasks = [
                jt("tax", dueDate: JEV_TODAY), jt("desk", dueDate: JEV_TODAY), jt("gym", dueDate: JEV_TODAY),
                jt("deck", dueDate: JEV_TODAY), jt("meeting", dueDate: JEV_TODAY, fixed: true), jt("blog", dueDate: "2026-11-14"),
            ]
            let judgments = [
                "tax": J(2.95, 0.32), "desk": J(0.99, 0.87), "gym": J(0.95, 0.89),
                "deck": J(2.2, 0.17, 0.9), "meeting": J(2, 0.16), "blog": J(1, 0.8),
            ]
            let plan = planPostpone(tasks: tasks, deps: [], mine: yes, editable: yes, judgments: judgments, today: JEV_TODAY, scope: .today, capacity: 4, capacitySource: .input)
            expectTrue(plan.overloaded)
            let moved = plan.candidates.filter { $0.verdict == .postpone }.map(\.taskId)
            expectEqual(moved.count, 2)
            expectTrue(moved.contains("gym"))
            expectFalse(moved.contains("tax"))
            expectEqual(plan.candidates.first { $0.taskId == "meeting" }?.verdict, .fixed)
            expectEqual(plan.days[0].load, 6)
            expectEqual(plan.days[0].after, 4)
            for c in plan.candidates where c.verdict == .postpone {
                expectTrue(c.toDate! > JEV_TODAY)
                expectTrue(c.shiftDays > 0)
            }
            let blog = try unwrap(plan.candidates.first { $0.taskId == "blog" })
            if let to = blog.toDate { expectEqual(blog.shiftDays, 2 + diffDays(to, JEV_TODAY)) }
        }

        test("never picks a slot that would break a fixed date downstream") {
            let prep = jt("prep", dueDate: JEV_TODAY)
            let talk = jt("talk", startDate: "2026-11-18", dueDate: "2026-11-18", fixed: true)
            let filler = ["f1", "f2", "f3"].map { jt($0, dueDate: JEV_TODAY) }
            var judgments = ["prep": J(0.5, 0.95)]
            for f in filler { judgments[f.id] = J(2.5, 0.1) }
            let plan = planPostpone(
                tasks: [prep, talk] + filler, deps: [PlanDependency(taskId: "talk", dependsOnId: "prep")], mine: yes, editable: yes,
                judgments: judgments, today: JEV_TODAY, scope: .today, capacity: 3, capacitySource: .input
            )
            let c = try unwrap(plan.candidates.first { $0.taskId == "prep" })
            expectEqual(c.verdict, .postpone)
            expectEqual(c.toDate, "2026-11-17")
        }

        test("a calm day recommends nothing but still lists what could wait") {
            let tasks = [jt("a", dueDate: JEV_TODAY), jt("b", dueDate: JEV_TODAY)]
            let plan = planPostpone(
                tasks: tasks, deps: [], mine: yes, editable: yes, judgments: ["a": J(0.5, 0.9), "b": J(3, 0.1)],
                today: JEV_TODAY, scope: .today, capacity: 5, capacitySource: .default
            )
            expectFalse(plan.overloaded)
            expectEqual(plan.candidates.map(\.verdict), [.could, .keep])
        }

        test("other people's tasks and read-only tasks are left alone") {
            let tasks = [jt("theirs", dueDate: JEV_TODAY, assigneeIds: ["other"]), jt("ro", dueDate: JEV_TODAY), jt("x", dueDate: JEV_TODAY)]
            let plan = planPostpone(
                tasks: tasks, deps: [], mine: { !$0.assigneeIds.contains("other") }, editable: { $0.id != "ro" },
                judgments: ["ro": J(0, 1), "x": J(0, 1)], today: JEV_TODAY, scope: .today, capacity: 1, capacitySource: .input
            )
            expectEqual(plan.candidates.map(\.taskId).sorted(), ["ro", "x"])
            expectEqual(plan.candidates.first { $0.taskId == "ro" }?.verdict, .keep)
            expectEqual(plan.candidates.first { $0.taskId == "x" }?.verdict, .postpone)
        }

        test("week scope evens out several overloaded days") {
            let d1 = "2026-11-17"
            let tasks = (0 ..< 4).map { jt("t\($0)", dueDate: d1) }
            var judgments: [String: TaskJudgment] = [:]
            for (i, t) in tasks.enumerated() { judgments[t.id] = J(1, 0.6 + Double(i) * 0.1) }
            let plan = planPostpone(tasks: tasks, deps: [], mine: yes, editable: yes, judgments: judgments, today: JEV_TODAY, scope: .week, capacity: 2, capacitySource: .input)
            expectEqual(plan.days.count, 7)
            let day = try unwrap(plan.days.first { $0.date == d1 })
            expectEqual(day.load, 4)
            expectEqual(day.after, 2)
            expectEqual(plan.candidates.filter { $0.verdict == .postpone }.map(\.taskId).sorted(), ["t2", "t3"])
        }
    }

    test("capacity follows the recent pace") {
        expectEqual(capacityFromHistory([], JEV_TODAY), CapacityEstimate(capacity: 5, source: .default))
        let days: [ISODate?] = (0 ..< 56).map { "2026-11-\(JS.pad(2 + ($0 % 14)))" }
        expectEqual(capacityFromHistory(days, JEV_TODAY), CapacityEstimate(capacity: 5, source: .history))
    }

    describe("System One endpoints") {
        test("a base URL gets /systemone; a full endpoint or a Workers AI run path is kept") {
            expectEqual(jevEndpoint(DEFAULT_JEV_BASE_URL), "https://api.typesafe.ai/v1/systemone")
            expectEqual(jevEndpoint("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/systemone")
            expectEqual(jevEndpoint("https://openrouter.ai/api/v1/systemone"), "https://openrouter.ai/api/v1/systemone")
            let cf = cloudflareJevUrl("0123456789abcdef0123456789abcdef", "clef-flash")
            expectEqual(cf, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash")
            expectEqual(jevEndpoint(cf), cf)
        }

        test("presets are recognised by host") {
            expectEqual(jevPresetOf(nil), .typesafe)
            expectEqual(jevPresetOf("https://openrouter.ai/api/v1"), .openrouter)
            expectEqual(jevPresetOf(cloudflareJevUrl("0123456789abcdef0123456789abcdef", "clef")), .cloudflare)
            expectNil(jevPresetOf("https://decide.example.com/v1"))
        }

        test("settings validation uses the server's words") {
            expectEqual(jevSettingsIssues(JevSettingsInput(apiKey: .some("short key"))).map(\.message), ["API 키가 너무 짧아요", "API 키에는 공백이 들어갈 수 없어요"])
            expectEqual(jevSettingsIssues(JevSettingsInput(apiKey: .some(nil), baseUrl: .some("ftp://x"), model: .some("  "))).map(\.message), [
                "Base URL은 https://로 시작해야 해요", "모델을 입력하세요", "모델 이름에는 공백이 들어갈 수 없어요",
            ])
            let body = String(decoding: try JSONEncoder().encode(JevSettingsInput(apiKey: .some(nil), autoApply: true)), as: UTF8.self)
            expectEqual(canonicalJSON(text: body.replacingOccurrences(of: "null", with: "0")), canonicalJSON(text: #"{"apiKey":0,"autoApply":true}"#))
        }
    }
}

private let WH_TODAY = "2026-11-13"

private func payload(
    event: String = "task.updated", actor: WebhookActor? = WebhookActor(id: "u", name: "민겸", via: .session, client: nil),
    subject: String = "#12 기획서", summary: String = "마감일 11/20 → 11/22"
) -> WebhookPayload {
    WebhookPayload(
        id: "e1", event: event, createdAt: "2026-11-13T00:00:00.000Z", workspace: WebhookWorkspaceRef(id: "w", name: "디자인팀", kind: .org),
        actor: actor, subject: subject, summary: summary, text: "", url: "https://obelisk.test/t/1"
    )
}

private func whItem(_ id: String, status: TaskStatus = .todo, startDate: String? = nil, dueDate: String? = nil, fixed: Bool = false) -> PlanItem {
    PlanItem(id: id, title: id, status: status, startDate: startDate, dueDate: dueDate, fixed: fixed, projectId: "p")
}

private func ok(_ body: JSONValue) throws -> JSONValue {
    switch parseIncoming(body, WH_TODAY) {
    case let .ok(c): return c.json
    case let .error(e): throw Missing(what: "command (error: \(e))")
    }
}

private func err(_ body: JSONValue) throws -> String {
    switch parseIncoming(body, WH_TODAY) {
    case let .ok(c): throw Missing(what: "an error, got \(c.json)")
    case let .error(e): return e
    }
}

func runWebhooksTests() {
    describe("webhookEventFor") {
        test("task events map to their own keys; completing is its own event") {
            expectEqual(webhookEventFor("task.created", [:]), WebhookEventRoute(key: .taskCreated, event: "task.created"))
            expectEqual(
                webhookEventFor("task.updated", ["changes": ["dueDate": ["from": "2026-11-20", "to": "2026-11-22"]]]),
                WebhookEventRoute(key: .taskUpdated, event: "task.updated")
            )
            expectEqual(
                webhookEventFor("task.updated", ["changes": ["status": ["from": "doing", "to": "done"]]]),
                WebhookEventRoute(key: .taskCompleted, event: "task.completed")
            )
            expectEqual(webhookEventFor("task.updated", ["changes": ["status": ["from": "done", "to": "todo"]]])?.key, .taskUpdated)
            expectEqual(webhookEventFor("task.postponed", [:])?.key, .taskPostponed)
        }

        test("a task restored from the trash goes to 새 작업 subscribers as task.restored") {
            expectEqual(webhookEventFor("task.restored", [:]), WebhookEventRoute(key: .taskCreated, event: "task.restored"))
        }

        test("dependencies, projects and organization events group under one key") {
            expectEqual(webhookEventFor("dependency.added", [:]), WebhookEventRoute(key: .taskDependency, event: "dependency.added"))
            expectEqual(webhookEventFor("project.archived", [:]), WebhookEventRoute(key: .project, event: "project.archived"))
            expectEqual(webhookEventFor("member.joined", [:]), WebhookEventRoute(key: .organization, event: "member.joined"))
            expectEqual(webhookEventFor("invite.created", [:])?.key, .organization)
            expectNil(webhookEventFor("something.else", [:]))
        }
    }

    describe("formats") {
        test("detects Slack and Discord incoming-webhook URLs") {
            expectEqual(detectWebhookFormat("https://hooks.slack.com/services/T0/B0/xyz"), .slack)
            expectEqual(detectWebhookFormat("https://discord.com/api/webhooks/1/abc"), .discord)
            expectEqual(detectWebhookFormat("https://discordapp.com/api/webhooks/1/abc"), .discord)
            expectEqual(detectWebhookFormat("https://discord.com/channels/1"), .json)
            expectEqual(detectWebhookFormat("https://example.com/hook"), .json)
            expectEqual(detectWebhookFormat("not a url"), .json)
        }

        test("masks the secret part of a URL") {
            expectEqual(maskWebhookUrl("https://hooks.slack.com/services/T0AAA/B0BBB/abcdef123456"), "hooks.slack.com/services/…3456")
            expectEqual(maskWebhookUrl("https://example.com/hook"), "example.com/hook")
            expectEqual(maskWebhookUrl("https://example.com"), "example.com")
        }

        test("event inputs are de-duplicated and need at least one event") {
            let input = CreateWebhookInput(name: "a", url: "https://x.com", events: [.taskCreated, .taskCreated])
            expectEqual(createWebhookIssues(input), [])
            expectEqual(input.normalized().events, [.taskCreated])
            expectFalse(createWebhookIssues(CreateWebhookInput(name: "a", url: "https://x.com", events: [])).isEmpty)
            expectFalse(createWebhookIssues(CreateWebhookInput(name: "a", url: "ftp://x.com", events: [.taskCreated])).isEmpty)
            expectEqual(createWebhookIssues(CreateWebhookInput(name: "", url: "", events: [])).map(\.message), [
                "이름을 입력하세요", "URL을 입력하세요", "https://로 시작하는 주소여야 합니다", "보낼 이벤트를 하나 이상 고르세요",
            ])
            expectEqual(createWebhookIssues(CreateWebhookInput(name: "a", url: "https://", events: [.taskCreated])).map(\.message), ["https://로 시작하는 주소여야 합니다"])
        }
    }

    describe("messages") {
        test("text line: actor · subject — summary, with the door it came through") {
            expectEqual(webhookText(payload()), "민겸 · #12 기획서 — 마감일 11/20 → 11/22")
            expectEqual(webhookText(payload(actor: WebhookActor(id: "u", name: "민겸", via: .webhook, client: "CI"))), "민겸 (웹훅 “CI” 통해) · #12 기획서 — 마감일 11/20 → 11/22")
            expectEqual(webhookText(payload(actor: nil, summary: "오늘 마감")), "#12 기획서 — 오늘 마감")
        }

        test("Slack: mrkdwn link, escaped names, no unfurl") {
            let m = chatMessage(payload(event: "task.completed", subject: "#12 A<B>&C", summary: "완료"), .slack)
            expectEqual(m["text"], "✅ *민겸* · <https://obelisk.test/t/1|#12 A&lt;B&gt;&amp;C> — 완료")
            expectEqual(m["unfurl_links"], false)
        }

        test("Discord: masked link without embed, markdown escaped, mentions off") {
            let m = chatMessage(payload(actor: WebhookActor(id: "u", name: "@everyone", via: .session, client: nil)), .discord)
            expectEqual(m["content"], .string("**@\u{200B}everyone** · [\\#12 기획서](<https://obelisk.test/t/1>) — 마감일 11/20 → 11/22"))
            expectEqual(m["allowed_mentions"], ["parse": []])
        }
    }

    describe("scheduleAlerts") {
        test("due today, due tomorrow and overdue (with days)") {
            let alerts = scheduleAlerts([
                whItem("a", dueDate: WH_TODAY), whItem("b", dueDate: "2026-11-14"), whItem("c", dueDate: "2026-11-10"),
                whItem("d", dueDate: "2026-11-20"), whItem("e", status: .done, dueDate: "2026-11-10"),
            ], [], WH_TODAY)
            expectEqual(alerts, [
                ScheduleAlert(key: .taskDueToday, taskId: "a"),
                ScheduleAlert(key: .taskDueSoon, taskId: "b"),
                ScheduleAlert(key: .taskOverdue, taskId: "c", daysOverdue: 3),
            ])
        }

        test("fixed-date conflict names the late task at the start of the chain") {
            let alerts = scheduleAlerts(
                [
                    whItem("late", startDate: "2026-11-09", dueDate: "2026-11-11"),
                    whItem("mid", startDate: "2026-11-12", dueDate: "2026-11-16"),
                    whItem("demo", startDate: "2026-11-16", dueDate: "2026-11-16", fixed: true),
                ],
                [PlanDependency(taskId: "mid", dependsOnId: "late"), PlanDependency(taskId: "demo", dependsOnId: "mid")],
                WH_TODAY
            )
            let conflict = try unwrap(alerts.first { $0.key == .fixedConflict })
            expectEqual(conflict.taskId, "demo")
            expectEqual(conflict.causeId, "late")
            expectTrue((conflict.overrunDays ?? 0) > 0)
            expectEqual(scheduleSummary(conflict, "#3 시안"), "고정 일정 충돌 · #3 시안 지연으로 \(conflict.overrunDays!)일 넘침")
            expectEqual(scheduleSummary(ScheduleAlert(key: .taskOverdue, daysOverdue: 2)), "마감 2일 지남")
        }
    }

    describe("parseIncoming") {
        test("plain text creates with quick-add syntax; later lines become notes") {
            expectEqual(try ok("보고서 초안 내일 !높음 #런칭"), ["kind": "create", "title": "보고서 초안", "dueDate": "2026-11-14", "priority": 3, "project": "런칭"])
            expectEqual(try ok("배포 확인\n로그 먼저 보기\n롤백 준비"), ["kind": "create", "title": "배포 확인", "notes": "로그 먼저 보기\n롤백 준비"])
            expectEqual(try ok(["text": "회의록 정리"]), ["kind": "create", "title": "회의록 정리"])
        }

        test("\"#12 …\" changes an existing task") {
            expectEqual(try ok("#12 완료"), ["kind": "update", "task": "#12", "patch": ["status": "done"]])
            expectEqual(try ok("#12 done."), ["kind": "update", "task": "#12", "patch": ["status": "done"]])
            expectEqual(try ok("#7 다시 열기"), ["kind": "update", "task": "#7", "patch": ["status": "todo"]])
            expectEqual(try ok("#12 시작"), ["kind": "update", "task": "#12", "patch": ["status": "doing"]])
            expectEqual(try ok("#12 금요일까지"), ["kind": "update", "task": "#12", "patch": ["dueDate": "2026-11-20"]])
            expectEqual(try ok("#12 !높음"), ["kind": "update", "task": "#12", "patch": ["priority": 3]])
            expectContains(try err("#12 이상한 말"), "이해하지 못했습니다")
            expectContains(try err("#12"), "#12 완료")
        }

        test("JSON create with friendly values") {
            expectEqual(
                try ok(["title": " 배포 확인 ", "dueDate": "내일", "priority": "high", "project": "런칭", "assignees": ["me", "민겸", "me"], "fixed": "true", "notes": "n"]),
                ["kind": "create", "title": "배포 확인", "dueDate": "2026-11-14", "priority": 3, "project": "런칭", "assignees": ["me", "민겸"], "fixed": true, "notes": "n"]
            )
            expectEqual(try ok(["title": "x", "assignee": "민겸, kim@example.com"])["assignees"], ["민겸", "kim@example.com"])
            let r = try ok(["title": "x", "dueDate": "2026-11-20T09:00:00Z", "priority": "보통"])
            expectEqual(r["dueDate"], "2026-11-20")
            expectEqual(r["priority"], 2)
            expectContains(try err(["title": "x", "dueDate": "언젠가"]), "dueDate")
            expectContains(try err(["title": "x", "priority": 9]), "priority")
            expectContains(try err(["title": "x", "startDate": "2026-11-20", "dueDate": "2026-11-18"]), "시작일")
            expectContains(try err([:]), "title")
        }

        test("JSON actions change a task by number or id only") {
            expectEqual(try ok(["action": "complete", "task": "#12"]), ["kind": "update", "task": "#12", "patch": ["status": "done"]])
            expectEqual(try ok(["action": "complete", "task": 12]), ["kind": "update", "task": "#12", "patch": ["status": "done"]])
            expectEqual(try ok(["action": "update", "task": "#3", "dueDate": nil, "priority": "low"]), ["kind": "update", "task": "#3", "patch": ["dueDate": nil, "priority": 1]])
            expectEqual(try ok(["task": "#3", "status": "진행 중"]), ["kind": "update", "task": "#3", "patch": ["status": "doing"]])
            expectContains(try err(["action": "update", "task": "#3"]), "바꿀 내용")
            expectContains(try err(["action": "complete", "task": "기획서"]), "작업 번호")
            expectContains(try err(["action": "explode", "task": "#1"]), "action")
            expectContains(try err(["action": "complete", "task": "#1", "status": "todo"]), "서로 다릅니다")
        }

        test("rejects bodies that are neither text nor an object") {
            expectContains(try err([1, 2]), "JSON 객체")
            expectContains(try err("   "), "비어")
        }
    }
}
