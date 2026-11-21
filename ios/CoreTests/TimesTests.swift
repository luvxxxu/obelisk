import Foundation

// Port of packages/core/test/times.test.ts.

private let TODAY = "2026-11-13" // Friday

private func at(_ hhmm: String, _ date: String = TODAY) -> Clock {
    let p = hhmm.split(separator: ":").map { Int($0)! }
    return Clock(date: date, minutes: p[0] * 60 + p[1])
}

/// A TaskItem with defaults, for the view tests.
func makeTask(
    id: String = UUID().uuidString, number: Int = 1, status: TaskStatus = .todo, priority: Int = 0, projectId: String? = nil,
    startDate: String? = nil, startTime: String? = nil, dueDate: String? = nil, dueTime: String? = nil,
    fixed: Bool = false, position: Double = 0, postponedCount: Int = 0, assigneeIds: [String] = [],
    createdBy: String? = "me", completedAt: String? = nil, title: String? = nil
) -> TaskItem {
    TaskItem(
        id: id, workspaceId: "w", number: number, title: title ?? id, notes: "", status: status, priority: priority,
        projectId: projectId, startDate: startDate, startTime: startTime, dueDate: dueDate, dueTime: dueTime,
        fixed: fixed, position: position, postponedCount: postponedCount, assigneeIds: assigneeIds, createdBy: createdBy,
        completedAt: completedAt, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z"
    )
}

private func item(
    _ id: String, status: TaskStatus = .todo, startDate: String? = nil, startTime: String? = nil,
    dueDate: String? = nil, dueTime: String? = nil, fixed: Bool = false
) -> PlanItem {
    PlanItem(
        id: id, title: id, status: status, startDate: startDate, dueDate: dueDate, startTime: startTime,
        dueTime: dueTime, fixed: fixed, projectId: "p"
    )
}

private func cmd(_ body: JSONValue, timeZone: String? = nil) throws -> JSONValue {
    switch parseIncoming(body, TODAY, timeZone: timeZone) {
    case let .ok(c): return c.json
    case let .error(e): throw Missing(what: "command (error: \(e))")
    }
}

func runTimesTests() {
    describe("time helpers") {
        test("valid times and Korean labels") {
            expectTrue(isISOTime("09:05"))
            expectFalse(isISOTime("24:00"))
            expectFalse(isISOTime("9:05"))
            expectEqual(formatTimeKo("09:05"), "오전 9:05")
            expectEqual(formatTimeKo("15:00"), "오후 3:00")
            expectEqual(formatTimeKo("12:30"), "오후 12:30")
            expectEqual(formatTimeKo("00:10"), "오전 12:10")
            expectEqual(formatTimeRangeKo("10:00", "11:30"), "오전 10:00 – 11:30")
            expectEqual(formatTimeRangeKo("11:00", "13:00"), "오전 11:00 – 오후 1:00")
            expectEqual(formatDurationKo(40), "40분")
            expectEqual(formatDurationKo(135), "2시간 15분")
            expectEqual(formatDurationKo(60), "1시간")
        }

        test("wall clock in a time zone") {
            // 2026-11-13 06:30 UTC is 15:30 in Seoul.
            expectEqual(nowIn("Asia/Seoul", now: JS.parseDate("2026-11-13T06:30:00Z")!), Clock(date: "2026-11-13", minutes: 930))
            expectEqual(nowIn("America/New_York", now: JS.parseDate("2026-11-13T03:00:00Z")!), Clock(date: "2026-11-12", minutes: 22 * 60))
        }

        test("past due: by day without a time, by minute with one") {
            expectFalse(isPastDue(TODAY, nil, at("23:59")))
            expectFalse(isPastDue(TODAY, "15:00", at("14:59")))
            expectTrue(isPastDue(TODAY, "15:00", at("15:00")))
            expectTrue(isPastDue("2026-11-12", nil, at("00:00")))
            expectEqual(minutesUntil("2026-11-14", "01:00", at("23:30")), 90)
        }

        test("span order compares times only on the same day") {
            expectFalse(spanInOrder(TODAY, "15:00", TODAY, "10:00"))
            expectTrue(spanInOrder(TODAY, "15:00", "2026-11-14", "10:00"))
            expectTrue(spanInOrder(TODAY, "15:00", TODAY, nil))
        }
    }

    describe("schemas") {
        test("a time needs its date, and start may not pass due") {
            expectEqual(spanIssues(dueTime: "15:00").first?.path, ["dueTime"])
            expectContains(spanIssues(startDate: TODAY, startTime: "15:00", dueDate: TODAY, dueTime: "10:00").first?.message ?? "", "시작 시각")
            expectEqual(spanIssues(dueDate: TODAY, dueTime: "15:30"), [])
            expectFalse(isISOTime("3pm"))
            expectEqual(spanIssues(startDate: "2026-11-14", dueDate: TODAY).first?.message, "시작일은 마감일보다 늦을 수 없습니다")
            expectEqual(spanIssues(startTime: "09:00").first?.message, "시작 시각은 시작일과 함께 정하세요")
        }
    }

    describe("parse times") {
        test("time phrases") {
            expectEqual(parseTimePhrase("오후 3시"), "15:00")
            expectEqual(parseTimePhrase("오후3시 30분"), "15:30")
            expectEqual(parseTimePhrase("3시 반"), "15:30")
            expectEqual(parseTimePhrase("9시"), "09:00")
            expectEqual(parseTimePhrase("저녁 7시"), "19:00")
            expectEqual(parseTimePhrase("밤 12시"), "23:59")
            expectEqual(parseTimePhrase("15:30"), "15:30")
            expectEqual(parseTimePhrase("09:00"), "09:00")
            expectEqual(parseTimePhrase("3pm"), "15:00")
            expectEqual(parseTimePhrase("9:30am"), "09:30")
            expectEqual(parseTimePhrase("정오"), "12:00")
            expectNil(parseTimePhrase("1:1"))
            expectNil(parseTimePhrase("3"))
            expectNil(parseTimePhrase("오전 15시"))
        }

        test("quick add with a date and a time") {
            let r = parseQuickAdd("치과 내일 오후 3시", TODAY)
            expectEqual(r.title, "치과")
            expectEqual(r.dueDate, "2026-11-14")
            expectEqual(r.dueTime, "15:00")
            expectNil(r.startDate)
            expectNil(r.startTime)
            let m = parseQuickAdd("3시 내일 회의", TODAY)
            expectEqual(m.title, "회의")
            expectEqual(m.dueDate, "2026-11-14")
            expectEqual(m.dueTime, "15:00")
            let o = parseQuickAdd("1:1 미팅 내일", TODAY)
            expectEqual(o.title, "1:1 미팅")
            expectNil(o.dueTime)
        }

        test("a slot within one day becomes start and due") {
            let r = parseQuickAdd("회의 금요일 10시~11시 반", "2026-11-11")
            expectEqual(r.title, "회의")
            expectEqual(r.startDate, "2026-11-13")
            expectEqual(r.startTime, "10:00")
            expectEqual(r.dueDate, "2026-11-13")
            expectEqual(r.dueTime, "11:30")
            let w = parseQuickAdd("워크숍 오후 2시-4시", TODAY, nowMinutes: 9 * 60)
            expectEqual(w.startDate, TODAY)
            expectEqual(w.startTime, "14:00")
            expectEqual(w.dueDate, TODAY)
            expectEqual(w.dueTime, "16:00")
        }

        test("a time alone is the next time it comes round") {
            let a = parseQuickAdd("보고서 3시까지", TODAY, nowMinutes: 10 * 60)
            expectEqual(a.dueDate, TODAY)
            expectEqual(a.dueTime, "15:00")
            let b = parseQuickAdd("보고서 3시까지", TODAY, nowMinutes: 16 * 60)
            expectEqual(b.dueDate, "2026-11-14")
            expectEqual(b.dueTime, "15:00")
        }

        test("a time on a date range lands on the due end") {
            let r = parseQuickAdd("워크숍 11/20~11/22 18시", TODAY)
            expectEqual(r.startDate, "2026-11-20")
            expectNil(r.startTime)
            expectEqual(r.dueDate, "2026-11-22")
            expectEqual(r.dueTime, "18:00")
        }

        test("a date field phrase") {
            expectEqual(parseDateTimePhrase("내일 오후 3시", TODAY), DateTimePhrase(date: "2026-11-14", time: "15:00"))
            expectEqual(parseDateTimePhrase("다음 주 금요일", TODAY), DateTimePhrase(date: "2026-11-20", time: nil))
            expectNil(parseDateTimePhrase("보고서", TODAY))
        }
    }

    describe("views") {
        test("a due time that passed today is overdue") {
            let task = makeTask(dueDate: TODAY, dueTime: "09:00")
            expectFalse(isOverdue(task, TODAY))
            expectFalse(isOverdue(task, TODAY, at("08:59")))
            expectTrue(isOverdue(task, TODAY, at("09:00")))
            expectEqual(selectView([task], .overdue, TODAY, at("10:00")).count, 1)
        }

        test("within a day: timed by time, then the ones without a time") {
            let a = makeTask(number: 1, dueDate: TODAY)
            let b = makeTask(number: 2, dueDate: TODAY, dueTime: "15:00")
            let c = makeTask(number: 3, dueDate: TODAY, dueTime: "09:30")
            expectEqual(sortTasks([a, b, c]).map(\.number), [3, 2, 1])
            expectEqual([a, b, c].sorted { compareTasks($0, $1) < 0 }.map(\.number), [3, 2, 1])
        }
    }

    describe("schedule alerts with times") {
        test("same-day overdue once the due time passes, with the time in the text") {
            let items = [item("a", dueDate: TODAY, dueTime: "15:00"), item("b", dueDate: "2026-11-14", dueTime: "09:30")]
            expectEqual(scheduleAlerts(items, [], TODAY, at("09:00")), [
                ScheduleAlert(key: .taskDueToday, taskId: "a", time: "15:00"),
                ScheduleAlert(key: .taskDueSoon, taskId: "b", time: "09:30"),
            ])
            let late = scheduleAlerts(items, [], TODAY, at("15:10"))
            expectEqual(late[0], ScheduleAlert(key: .taskOverdue, taskId: "a", daysOverdue: 0, time: "15:00"))
            expectEqual(scheduleSummary(late[0]), "마감 시각 오후 3:00 지남")
            expectEqual(scheduleSummary(ScheduleAlert(key: .taskDueSoon, time: "09:30")), "내일 오전 9:30 마감")
        }

        test("reminders open `lead` minutes before and close at the moment") {
            let items = [
                item("due", dueDate: TODAY, dueTime: "15:00"),
                item("start", startDate: TODAY, startTime: "10:00", dueDate: TODAY),
                item("doing", status: .doing, startDate: TODAY, startTime: "10:00"),
                item("allday", dueDate: TODAY),
            ]
            expectEqual(reminderAlerts(items, at("14:29"), 30), [])
            expectEqual(reminderAlerts(items, at("14:30"), 30), [
                Reminder(key: .taskDueReminder, taskId: "due", date: TODAY, time: "15:00", minutesLeft: 30),
            ])
            expectEqual(reminderAlerts(items, at("15:00"), 30), [])
            // Started tasks get no start reminder.
            expectEqual(reminderAlerts(items, at("09:50"), 30).map(\.taskId), ["start"])
            expectEqual(reminderAlerts(items, at("09:50"), 30, [.taskDueReminder]), [])
            // "At the time": a short grace after it.
            expectEqual(reminderAlerts(items, at("15:05"), 0).map(\.minutesLeft), [-5])
            expectEqual(reminderAlerts(items, at("15:10"), 0), [])
        }

        test("reminders a day ahead cross midnight") {
            let items = [item("early", dueDate: "2026-11-14", dueTime: "08:00")]
            let r = try unwrap(reminderAlerts(items, at("09:00"), 1440).first)
            expectEqual(r.minutesLeft, 23 * 60)
            expectEqual(reminderSummary(r, TODAY), "23시간 뒤 마감 · 내일 오전 8:00")
            expectEqual(
                reminderSummary(Reminder(key: .taskStartReminder, date: TODAY, time: "10:00", minutesLeft: 0), TODAY),
                "지금 시작 · 오전 10:00"
            )
        }
    }

    describe("incoming with times") {
        test("text commands carry times") {
            let a = try cmd("치과 내일 오후 3시")
            expectEqual(a["kind"], "create")
            expectEqual(a["title"], "치과")
            expectEqual(a["dueDate"], "2026-11-14")
            expectEqual(a["dueTime"], "15:00")
            expectEqual(try cmd("#12 내일 15:30까지"), ["kind": "update", "task": "#12", "patch": ["dueDate": "2026-11-14", "dueTime": "15:30"]])
        }

        test("JSON dates with a time, separate time fields, offsets and plain midnights") {
            let a = try cmd(["title": "x", "dueDate": "2026-11-20T15:30"])
            expectEqual(a["dueDate"], "2026-11-20")
            expectEqual(a["dueTime"], "15:30")
            let b = try cmd(["title": "x", "dueDate": "2026-11-20", "dueTime": "오후 3시"])
            expectEqual(b["dueDate"], "2026-11-20")
            expectEqual(b["dueTime"], "15:00")
            let c = try cmd(["title": "x", "due": "2026-11-20T06:30:00Z"], timeZone: "Asia/Seoul")
            expectEqual(c["dueDate"], "2026-11-20")
            expectEqual(c["dueTime"], "15:30")
            expectEqual(try cmd(["title": "x", "dueDate": "2026-11-20T00:00:00Z"], timeZone: "Asia/Seoul"), [
                "kind": "create", "title": "x", "dueDate": "2026-11-20",
            ])
            expectEqual(try cmd(["action": "update", "task": "#3", "dueTime": nil]), ["kind": "update", "task": "#3", "patch": ["dueTime": nil]])
            let bad = parseIncoming(["title": "x", "startDate": .string(TODAY), "startTime": "15:00", "dueDate": .string(TODAY), "dueTime": "10:00"], TODAY)
            expectFalse(bad.isOk)
        }
    }
}
