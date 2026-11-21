import Foundation

// Tests for the ports of web/src/lib (format, reschedule, clock, hooks) and for decoding API responses.

private let TODAY = "2026-11-13" // Friday

func runFormatTests() {
    describe("format") {
        test("labels") {
            expectEqual(withTime("오늘", "15:00"), "오늘 오후 3:00")
            expectEqual(withTime("오늘", nil), "오늘")
            expectEqual(daysLabel(14), "2주")
            expectEqual(daysLabel(-3), "3일")
            expectEqual(longDateKo("2026-11-20"), "11월 20일 금요일")
            expectEqual(overdueLabel("2026-11-12", TODAY), "어제 마감")
            expectEqual(overdueLabel("2026-11-10", TODAY), "3일 지남")
            expectEqual(overdueLabel(TODAY, TODAY, "09:00", Clock(date: TODAY, minutes: 9 * 60 + 40)), "40분 지남")
            expectEqual(overdueLabel(TODAY, TODAY), "마감 지남")
            expectEqual(dueSoonLabel(makeTask(dueDate: TODAY, dueTime: "10:00"), Clock(date: TODAY, minutes: 9 * 60 + 20)), "40분 남음")
            expectNil(dueSoonLabel(makeTask(dueDate: TODAY, dueTime: "12:00"), Clock(date: TODAY, minutes: 9 * 60)))
        }

        test("spans and tones") {
            expectEqual(spanLabel(makeTask(startDate: "2026-11-11", dueDate: "2026-11-14", dueTime: "18:00"), TODAY), "내일 오후 6:00까지")
            expectEqual(spanLabel(makeTask(startDate: "2026-11-18", dueDate: "2026-11-20"), TODAY), "11/18 (수) – 11/20 (금)")
            expectEqual(spanLabel(makeTask(startDate: TODAY, startTime: "10:00", dueDate: TODAY, dueTime: "11:30"), TODAY), "오늘 오전 10:00 – 11:30")
            expectEqual(spanLabel(makeTask(startDate: TODAY, startTime: "10:00", dueDate: TODAY), TODAY), "오늘 오전 10:00부터")
            expectNil(spanLabel(makeTask(), TODAY))
            expectEqual(spanLabel(DateSpan(startDate: nil, dueDate: "2026-11-16"), TODAY), "월요일")
            expectEqual(timeLabel(makeTask(startDate: TODAY, startTime: "10:00", dueDate: TODAY, dueTime: "11:30")), "오전 10:00 – 11:30")
            expectEqual(dateTone(makeTask(dueDate: "2026-11-12"), TODAY), .overdue)
            expectEqual(dateTone(makeTask(dueDate: TODAY, dueTime: "09:00"), TODAY, Clock(date: TODAY, minutes: 600)), .overdue)
            expectEqual(dateTone(makeTask(dueDate: "2026-11-15"), TODAY), .soon)
            expectEqual(dateTone(makeTask(status: .done, dueDate: "2026-11-12"), TODAY), .done)
            expectEqual(DateTone.default.rawValue, "default")
        }

        test("relativeTime and completedOn") {
            let now = JS.parseDate("2026-11-19T10:00:00Z")!
            expectEqual(relativeTime(nil, now: now), "사용 기록 없음")
            expectEqual(relativeTime("2026-11-19T09:59:30.000Z", now: now), "방금 전")
            expectEqual(relativeTime("2026-11-19T07:00:00Z", now: now), "3시간 전")
            expectEqual(relativeTime("2026-10-01T00:00:00Z", now: now, timeZone: TimeZone(identifier: "Asia/Seoul")!), "2026. 10. 1.")
            expectEqual(completedOn(makeTask(completedAt: "2026-11-13T16:30:00.000Z"), "Asia/Seoul"), "2026-11-14")
            expectEqual(completedOn(makeTask(completedAt: "2026-11-13T16:30:00.000Z"), "UTC"), "2026-11-13")
            expectNil(completedOn(makeTask(), "UTC"))
        }

        test("clock helpers") {
            let instant = JS.parseDate("2026-11-13T06:30:20Z")!
            expectEqual(clockNow("Asia/Seoul", now: instant), Clock(date: TODAY, minutes: 930))
            expectEqual(nextMinuteDelay(instant), 40.05, "seconds to the next minute + 50 ms")
            expectEqual(todayIn("Not/AZone", now: instant), TODAY)
            expectTrue(isValidTimeZone("Asia/Seoul"))
            expectFalse(isValidTimeZone("Not/AZone"))
        }

        test("JS-style ISO parsing") {
            expectEqual(JS.parseDate("2026-11-13")?.timeIntervalSince1970, 1_794_528_000)
            expectEqual(JS.parseDate("2026-11-13T09:00+09:00")?.timeIntervalSince1970, 1_794_528_000)
            expectEqual(JS.parseDate("2026-11-13T09:00", localZone: TimeZone(identifier: "Asia/Seoul")!)?.timeIntervalSince1970, 1_794_528_000)
            expectNil(JS.parseDate("2026-02-30T00:00Z"))
            expectNil(JS.parseDate("garbage"))
        }
    }

    describe("reschedule") {
        let a = makeTask(id: "a", startDate: "2026-11-16", dueDate: "2026-11-18", title: "기획서")
        let b = makeTask(id: "b", startDate: "2026-11-19", dueDate: "2026-11-20", title: "시안")
        let items = planItems([a, b])
        let deps = [PlanDependency(taskId: "b", dependsOnId: "a")]

        test("same dates, new times only patch the times") {
            let r = planDateChange(a, TimedSpan(startDate: "2026-11-16", dueDate: "2026-11-18", dueTime: .some("15:00")), items, deps)
            expectEqual(r, .timesOnly(ResolvedTimes(startTime: nil, dueTime: "15:00")))
            expectEqual(planDateChange(a, TimedSpan(startDate: "2026-11-16", dueDate: "2026-11-18"), items, deps), .unchanged)
        }

        test("a push into a dependent asks first; resolving gives the changes and the toast") {
            guard case let .confirm(p) = planDateChange(a, TimedSpan(startDate: "2026-11-16", dueDate: "2026-11-21", dueTime: .some("18:00")), items, deps) else {
                throw Missing(what: ".confirm")
            }
            expectEqual(p.title, "기획서")
            let cascade = pendingChanges(p, .cascade)
            expectEqual(cascade.map(\.taskId), ["a", "b"])
            expectEqual(cascade[0].dueTime, .some("18:00"))
            expectEqual(cascade[1].dueTime, nil)
            expectEqual(pendingChanges(p, .only).count, 1)
            expectEqual(undoChanges(cascade, [a, b]).map(\.dueDate), ["2026-11-18", "2026-11-20"])
            expectEqual(rescheduleToast(2, "기획서", nil, TODAY), "2개 작업 일정을 함께 옮겼어요")
            var after = a
            after.dueDate = "2026-11-14"
            after.dueTime = "15:00"
            expectEqual(rescheduleToast(1, "기획서", after, TODAY), "“기획서” → 내일 오후 3:00")
            expectEqual(rescheduleToast(1, "기획서", makeTask(), TODAY), "“기획서” → 날짜 없음")
        }

        test("a harmless move applies at once") {
            let r = planDateChange(b, TimedSpan(startDate: "2026-11-20", dueDate: "2026-11-21"), items, deps)
            expectEqual(r, .apply([DateChange(taskId: "b", startDate: "2026-11-20", dueDate: "2026-11-21")]))
        }

        test("several tasks moved together preview as one group") {
            let fixedB = makeTask(id: "fb", startDate: "2026-11-22", dueDate: "2026-11-22", fixed: true, title: "발표")
            let first = makeTask(id: "a1", dueDate: "2026-11-21", dueTime: "15:00", title: "자료")
            let other = makeTask(id: "c1", dueDate: "2026-11-21", title: "메일")
            let all = [first, fixedB, other, b]
            let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
            let groupDeps = [PlanDependency(taskId: "fb", dependsOnId: "a1")]
            let week = [first, other].map { GroupMove(taskId: $0.id, next: TimedSpan(startDate: nil, dueDate: "2026-11-28")) }
            let p = previewGroup(week, byId, planItems(all), groupDeps)
            expectTrue(p.hasImpact, "a fixed date breaks")
            expectEqual(p.report.summary.conflictCount, 1)
            expectEqual(p.shiftDays, 7)
            expectEqual(p.only.map(\.taskId), ["a1", "c1"])
            expectEqual(p.only[0].dueTime, .some("15:00"))
            expectEqual(p.cascade.map(\.taskId), ["a1", "c1"], "a fixed task is never moved for you")
            let pending = PendingChange(taskId: "a1", title: "작업 2개", next: week[0].next, preview: p, count: 2)
            expectEqual(pendingChanges(pending, .only), p.only)

            // Moving a task and the one waiting on it: the dependent is a root, not pushed twice.
            let both = [GroupMove(taskId: "a", next: TimedSpan(startDate: "2026-11-18", dueDate: "2026-11-20")),
                        GroupMove(taskId: "b", next: TimedSpan(startDate: "2026-11-21", dueDate: "2026-11-22"))]
            let q = previewGroup(both, ["a": a, "b": b], items, deps)
            expectEqual(q.cascade.map(\.taskId), ["a", "b"])
            expectEqual(q.cascade[1].dueDate, "2026-11-22")
            let alone = previewGroup([both[0]], ["a": a, "b": b], items, deps)
            expectTrue(alone.hasImpact)
            expectEqual(alone.cascade.map(\.taskId), ["a", "b"])
        }

        test("same-day times stay in order") {
            let t = makeTask(startDate: TODAY, startTime: "10:00", dueDate: TODAY, dueTime: "11:30")
            let moved = orderTimes(t, TimedSpan(startDate: TODAY, dueDate: TODAY, startTime: .some("13:00")))
            expectEqual(moved.dueTime, .some("14:30"))
            let pulled = orderTimes(t, TimedSpan(startDate: TODAY, dueDate: TODAY, dueTime: .some("09:00")))
            expectEqual(pulled.startTime, .some("07:30"))
        }
    }

    describe("API responses decode") {
        test("impact, jev, webhooks and overview shapes from the server") {
            let report = #"{"rootIds":["a"],"impacts":[{"taskId":"a","title":"A","number":3,"projectId":null,"kind":"root","shiftDays":2,"overrunDays":0,"slackDays":null,"from":{"startDate":null,"dueDate":"2026-11-13"},"to":{"startDate":null,"dueDate":"2026-11-15"},"depth":0,"viaId":null}],"summary":{"delayedCount":0,"conflictCount":0,"absorbedCount":0,"unscheduledCount":0,"maxShiftDays":2,"projectSlips":[],"finishFrom":"2026-11-13","finishTo":"2026-11-15"}}"#
            let r = try JSONDecoder().decode(ImpactForecastResponse.self, from: Data(#"{"today":"2026-11-13","report":\#(report)}"#.utf8))
            expectEqual(r.report.impacts.first?.number, 3)
            let lev = try JSONDecoder().decode(ImpactLeverageResponse.self, from: Data(#"{"leverage":[{"taskId":"a","downstreamCount":2,"slackDays":null,"delayedIfLate":1,"conflictsIfLate":0}]}"#.utf8))
            expectNil(lev.leverage[0].slackDays)

            let pri = #"{"today":"2026-11-13","model":null,"suggestions":[{"taskId":"a","current":0,"suggested":3,"score":0.71,"confidence":0.9,"reasons":["오늘 마감"],"judgment":{"importance":2.9,"importanceConfidence":0.95,"others":0.2,"deferrable":0.1}}],"focus":{"taskId":"a","reasons":["오늘 마감"]}}"#
            let p = try JSONDecoder().decode(PrioritiesResult.self, from: Data(pri.utf8))
            expectEqual(p.focus?.taskId, "a")
            let triage = try JSONDecoder().decode(JevTriageResponse.self, from: Data(#"{"suggestion":{"project":{"id":null,"confidence":0.4},"priority":{"value":2,"confidence":0.8,"reasons":[]},"fixed":{"value":false,"probability":0.1}}}"#.utf8))
            expectNil(triage.suggestion.project?.id)

            let hooks = #"{"canManage":true,"webhooks":[{"id":"h","name":"Slack","url":"https://hooks.slack.com/services/x","format":"slack","events":["task.created","fixed.conflict"],"projectIds":null,"alertHour":9,"remindMinutes":30,"timezone":"Asia/Seoul","enabled":true,"disabledReason":null,"failureCount":0,"lastDelivery":{"status":"success","at":"2026-11-13T00:00:00.000Z","responseStatus":200},"createdBy":{"id":"u","name":"민겸"},"createdAt":"x","updatedAt":"x"}],"incoming":[{"id":"i","name":"CI","hint":"ab12","projectId":null,"allowUpdates":true,"useCount":3,"lastUsedAt":null,"lastError":null,"lastErrorAt":null,"createdBy":null,"createdAt":"x"}]}"#
            let ov = try JSONDecoder().decode(WebhooksOverview.self, from: Data(hooks.utf8))
            expectEqual(ov.webhooks[0].events, [.taskCreated, .fixedConflict])
            expectEqual(ov.webhooks[0].events.map(\.label), ["새 작업", "고정 일정 충돌"])
            let delivery = #"{"delivery":{"id":"d","webhookId":"h","event":"ping","status":"pending","attempts":0,"maxAttempts":6,"nextAttemptAt":"x","lastAttemptAt":null,"responseStatus":null,"responseBody":null,"error":null,"durationMs":null,"createdAt":"x","payload":{"id":"e","event":"ping","createdAt":"x","workspace":{"id":"w","name":"개인","kind":"personal"},"actor":{"id":"u","name":"민겸","via":"session","client":null},"subject":"","summary":"연결 확인","text":"민겸 — 연결 확인","url":null}}}"#
            expectEqual(try JSONDecoder().decode(WebhookDeliveryResponse.self, from: Data(delivery.utf8)).delivery.payload.summary, "연결 확인")

            let update = String(decoding: try JSONEncoder().encode(UpdateWebhookInput(projectIds: .some(nil), enabled: false)), as: UTF8.self)
            expectContains(update, "\"projectIds\":null")
            expectFalse(update.contains("name"))
        }
    }

    describe("catalogs") {
        test("webhook events, groups and labels") {
            expectEqual(WEBHOOK_EVENT_KEYS.count, 14)
            expectEqual(WEBHOOK_EVENT_GROUPS.flatMap(\.events).count, 14)
            expectEqual(WEBHOOK_EVENT_GROUPS.first { $0.orgOnly }?.id, .organization)
            expectTrue(isScheduleEvent("task.overdue"))
            expectFalse(isScheduleEvent("task.created"))
            expectTrue(isReminderEvent("task.due_reminder"))
            expectEqual(REMINDER_LEAD_OPTIONS.map(remindLeadLabel), ["정각에", "5분 전", "10분 전", "15분 전", "30분 전", "1시간 전", "2시간 전", "1일 전"])
            expectEqual(WebhookFormat.slack.label, "Slack")
            expectEqual(updateWebhookIssues(UpdateWebhookInput(alertHour: 24)).map(\.message), ["Too big: expected number to be <=23"])
            expectEqual(incomingWebhookIssues(name: "  ").map(\.message), ["이름을 입력하세요"])
        }

        test("jsonb key order for activity") {
            expectEqual(jsonbKeyOrder(["startDate", "title", "dueDate", "fixed", "status", "notes"]), ["fixed", "notes", "title", "status", "dueDate", "startDate"])
        }
    }
}
