import Foundation

// Replays ParityFixtures.swift: a corpus of inputs run through the TypeScript (quick add, labels, views,
// the impact engine, Jev planning, activity sentences, webhooks, incoming parsing, reschedule), and checks
// the Swift port returns the same thing for every one.

private var shown = 0
/// Every parity comparison made (printed in the summary).
var parityComparisons = 0

/// One parity check inside a section test; prints the first few mismatches of the section in full.
private func same(_ actual: String, _ expected: String, _ what: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
    parityComparisons += 1
    guard actual != expected else { return }
    if shown < 6 {
        expectEqual(actual, expected, what(), file: file, line: line)
    } else {
        TestRun.failures += 1
    }
    shown += 1
}

private func encodeKeepingNulls(_ v: JSONValue) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? enc.encode(v)) ?? Data(), as: UTF8.self)
}

private func json<T: Encodable>(_ v: T?) -> String {
    guard let v else { return "null" }
    return canonicalJSON(v)
}

private func expected(_ v: JSONValue?) -> String {
    guard let v, v != .null else { return "null" }
    return canonicalJSON(v)
}

private func str(_ v: JSONValue?) -> String? { v?.string }

private func dec<T: Decodable>(_ v: JSONValue?, _ type: T.Type = T.self) throws -> T {
    try (v ?? .null).decode(T.self)
}

private func section(_ fixtures: JSONValue, _ name: String, _ body: (JSONValue, Int) throws -> Void) {
    test("\(name) matches the TypeScript") {
        shown = 0
        let cases = try unwrap(fixtures[name]?.array, "fixtures[\(name)]")
        expectTrue(!cases.isEmpty, "no \(name) cases")
        for (i, c) in cases.enumerated() { try body(c, i) }
        if shown > 6 { print("    … and \(shown - 6) more mismatches in \(name)") }
    }
}

private struct NamedThing: HasName { var name: String }

func runParityTests() {
    let fixtures: JSONValue
    do {
        fixtures = try JSONDecoder().decode(JSONValue.self, from: Data(PARITY_FIXTURES.utf8))
    } catch {
        test("parity fixtures decode") { throw error }
        return
    }

    describe("parity") {
        section(fixtures, "quickadd") { c, i in
            let disabled = (c["disabled"]?.array ?? []).compactMap { $0.string.flatMap(QuickAddKind.init(rawValue:)) }
            let r = parseQuickAdd(str(c["input"])!, str(c["today"])!, disabled: disabled, nowMinutes: c["nowMinutes"]?.int)
            same(json(r), expected(c["out"]), "#\(i) \(str(c["input"])!)")
        }
        section(fixtures, "datePhrase") { c, i in
            same(parseDatePhrase(str(c["raw"])!, str(c["today"])!) ?? "null", str(c["out"]) ?? "null", "#\(i) \(str(c["raw"])!) @\(str(c["today"])!)")
        }
        section(fixtures, "timePhrase") { c, i in
            same(parseTimePhrase(str(c["raw"])!) ?? "null", str(c["out"]) ?? "null", "#\(i) \(str(c["raw"])!)")
        }
        section(fixtures, "duration") { c, i in
            same(parseDuration(str(c["raw"])!).map { String($0) } ?? "null", c["out"]?.int.map { String($0) } ?? "null", "#\(i) \(str(c["raw"])!)")
        }
        section(fixtures, "dateTimePhrase") { c, i in
            let r = parseDateTimePhrase(str(c["raw"])!, str(c["today"])!, c["nowMinutes"]?.int)
            same(json(r), expected(c["out"]), "#\(i) \(str(c["raw"])!)")
        }
        section(fixtures, "matchProject") { c, i in
            let ps = (c["projects"]?.array ?? []).map { NamedThing(name: $0.string!) }
            same(matchProject(ps, str(c["q"])!)?.name ?? "null", str(c["out"]) ?? "null", "#\(i) \(str(c["q"])!)")
        }
        section(fixtures, "relative") { c, i in
            same(formatRelativeKo(str(c["date"])!, str(c["today"])!), str(c["out"])!, "#\(i)")
        }
        section(fixtures, "dateMisc") { c, _ in
            let d = str(c["date"])!
            same(formatShortKo(d), str(c["short"])!, "short \(d)")
            same(longDateKo(d), str(c["long"])!, "long \(d)")
            same(String(weekday(d)), String(c["weekday"]!.int!), "weekday \(d)")
            same(endOfMonth(d), str(c["endOfMonth"])!, "endOfMonth \(d)")
            same(startOfWeek(d), str(c["startOfWeek"])!, "startOfWeek \(d)")
            same(addDays(d, 400), str(c["plus"])!, "plus \(d)")
            same(addDays(d, -400), str(c["minus"])!, "minus \(d)")
            same(String(toDay(d)), String(c["toDay"]!.int!), "toDay \(d)")
        }
        section(fixtures, "isISODate") { c, _ in
            same(String(isISODate(str(c["s"])!)), String(c["out"]!.bool!), "isISODate \(str(c["s"])!.debugDescription)")
        }
        section(fixtures, "isISOTime") { c, _ in
            same(String(isISOTime(str(c["s"])!)), String(c["out"]!.bool!), "isISOTime \(str(c["s"])!.debugDescription)")
        }
        section(fixtures, "daysKo") { c, _ in same(formatDaysKo(c["n"]!.int!), str(c["out"])!, "days \(c["n"]!.int!)") }
        section(fixtures, "durationKo") { c, _ in same(formatDurationKo(c["n"]!.int!), str(c["out"])!, "duration \(c["n"]!.int!)") }
        section(fixtures, "timeRange") { c, _ in
            same(formatTimeRangeKo(str(c["a"])!, str(c["b"])!), str(c["out"])!, "range \(str(c["a"])!)–\(str(c["b"])!)")
        }
        section(fixtures, "nowIn") { c, _ in
            let instant = try unwrap(JS.parseDate(str(c["iso"])!), "date \(str(c["iso"])!)")
            same(json(nowIn(str(c["tz"])!, now: instant)), expected(c["out"]), "nowIn \(str(c["tz"])!) \(str(c["iso"])!)")
            same(todayIn(str(c["tz"])!, now: instant), str(c["today"])!, "todayIn \(str(c["tz"])!)")
        }
        section(fixtures, "format") { c, i in
            let t: TaskItem = try dec(c["task"])
            let today = str(c["today"])!
            let now: Clock? = c["now"] == .null ? nil : try dec(c["now"])
            same(dateTone(t, today, now).rawValue, str(c["tone"])!, "#\(i) tone")
            same(spanLabel(t, today) ?? "null", str(c["span"]) ?? "null", "#\(i) span")
            same(timeLabel(t) ?? "null", str(c["time"]) ?? "null", "#\(i) time")
            if let due = t.dueDate { same(overdueLabel(due, today, t.dueTime, now), str(c["overdue"])!, "#\(i) overdue") }
            if let now { same(dueSoonLabel(t, now) ?? "null", str(c["dueSoon"]) ?? "null", "#\(i) dueSoon") }
            for v in ViewName.allCases {
                same(String(matchesView(t, v, today, now)), String(c["views"]![v.rawValue]!.bool!), "#\(i) view \(v)")
            }
            same(json(urgencyOf(t, today)), expected(c["urgency"]), "#\(i) urgency")
        }
        section(fixtures, "views") { c, i in
            let tasks: [TaskItem] = try dec(c["tasks"])
            let now: Clock? = c["now"] == .null ? nil : try dec(c["now"])
            let view = ViewName(rawValue: str(c["view"])!)!
            same(json(selectView(tasks, view, str(c["today"])!, now).map(\.id)), expected(c["out"]), "#\(i) \(view)")
        }
        section(fixtures, "overview") { c, i in
            let tasks: [TaskItem] = try dec(c["tasks"])
            let today = str(c["today"])!
            let kind = WorkspaceKind(rawValue: str(c["kind"])!)!
            same(json(tasks.map { inOverview($0, kind, "me", today) }), expected(c["inOverview"]), "#\(i) inOverview")
            let s = overviewSections(tasks, today)
            let mine: JSONValue = [
                "overdue": .array(s.overdue.map { .string($0.id) }),
                "today": .array(s.today.map { .string($0.id) }),
                "week": .array(s.week.map { ["date": .string($0.date), "ids": .array($0.tasks.map { .string($0.id) })] }),
                "fixed": .array(s.fixed.map { [.string($0.task.id), .string($0.date)] }),
            ]
            same(json(mine), expected(c["out"]), "#\(i) sections")
        }
        section(fixtures, "relativeTime") { c, i in
            let now = JS.parseDate("2026-11-19T10:00:00.000Z")!
            same(relativeTime(str(c["iso"]), now: now, timeZone: TimeZone(identifier: "Asia/Seoul")!), str(c["out"])!, "#\(i) \(str(c["iso"]) ?? "nil")")
        }
        section(fixtures, "simulate") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let deps: [PlanDependency] = try dec(c["deps"])
            let shifts = (c["shifts"]?.array ?? []).map { ($0[0]!.string!, $0[1]!.int!) }
            same(json(simulate(items, deps, orderedShifts: shifts)), expected(c["out"]), "#\(i)")
        }
        section(fixtures, "forecast") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let deps: [PlanDependency] = try dec(c["deps"])
            same(json(forecast(items, deps, str(c["today"])!)), expected(c["out"]), "#\(i)")
        }
        section(fixtures, "leverage") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let deps: [PlanDependency] = try dec(c["deps"])
            same(json(leverage(items, deps)), expected(c["out"]), "#\(i)")
        }
        section(fixtures, "preview") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let deps: [PlanDependency] = try dec(c["deps"])
            let next: DateSpan = try dec(c["next"])
            same(json(previewDateChange(items, deps, str(c["taskId"])!, next)), expected(c["out"]), "#\(i)")
        }
        section(fixtures, "cycles") { c, i in
            let deps: [PlanDependency] = try dec(c["deps"])
            let pairs = c["pairs"]?.array ?? []
            for (a, row) in pairs.enumerated() {
                for (b, v) in (row.array ?? []).enumerated() {
                    same(String(wouldCreateCycle(deps, "t\(a)", "t\(b)")), String(v.bool!), "#\(i) cycle t\(a)→t\(b)")
                }
            }
            for (a, v) in (c["downstream"]?.array ?? []).enumerated() {
                same(json(downstreamOf(deps, "t\(a)")), expected(v), "#\(i) downstream t\(a)")
            }
        }
        section(fixtures, "jev") { c, i in
            let tasks: [TaskItem] = try dec(c["tasks"])
            let deps: [PlanDependency] = try dec(c["deps"])
            let judgments: [String: TaskJudgment] = try dec(c["judgments"])
            let today = str(c["today"])!
            let notMine = Set((c["notMine"]?.array ?? []).compactMap(\.string))
            let readOnly = Set((c["readOnly"]?.array ?? []).compactMap(\.string))
            let plan = planPostpone(
                tasks: tasks, deps: deps, mine: { !notMine.contains($0.id) }, editable: { !readOnly.contains($0.id) },
                judgments: judgments, today: today, scope: PostponeScope(rawValue: str(c["scope"])!)!,
                capacity: c["capacity"]!.int!, capacitySource: .input
            )
            same(json(plan), expected(c["plan"]), "#\(i) plan")
            let lev = Dictionary(leverage(planItems(tasks), deps).map { ($0.taskId, $0) }, uniquingKeysWith: { a, _ in a })
            let suggestions = tasks.filter { judgments[$0.id] != nil }.map { suggestPriority($0, judgments[$0.id]!, lev[$0.id], today) }
            same(json(suggestions), expected(c["suggestions"]), "#\(i) suggestions")
            let scores = Dictionary(suggestions.map { ($0.taskId, $0.score) }, uniquingKeysWith: { a, _ in a })
            same(pickFocus(tasks, deps, scores, today) ?? "null", str(c["focus"]) ?? "null", "#\(i) focus")
            let completed = tasks.map { $0.completedAt.map { JS.slice($0, 0, 10) } }
            same(json(capacityFromHistory(completed, today)), expected(c["capacityFromHistory"]), "#\(i) capacity")
        }
        section(fixtures, "activity") { c, i in
            let action = str(c["action"])!
            let data = c["data"]?.object ?? [:]
            same(describeActivity(action: action, data: data, subject: "s"), str(c["out"])!, "#\(i) \(action)")
            same(activityKind(action).rawValue, str(c["kind"])!, "#\(i) kind")
            same(json(webhookEventFor(action, data)), expected(c["event"]), "#\(i) event")
        }
        section(fixtures, "via") { c, i in
            same(viaLabelKo(ActivityVia(rawValue: str(c["via"])!)!, str(c["client"])) ?? "null", str(c["out"]) ?? "null", "#\(i)")
        }
        section(fixtures, "urls") { c, _ in
            let url = str(c["url"])!
            same(maskWebhookUrl(url), str(c["mask"])!, "mask \(url)")
            same(detectWebhookFormat(url).rawValue, str(c["format"])!, "format \(url)")
        }
        section(fixtures, "jevUrls") { c, _ in
            let base = str(c["base"])!
            same(jevEndpoint(base), str(c["endpoint"])!, "endpoint \(base)")
            same(jevPresetOf(base)?.rawValue ?? "null", str(c["preset"]) ?? "null", "preset \(base)")
        }
        section(fixtures, "alerts") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let deps: [PlanDependency] = try dec(c["deps"])
            let now: Clock? = c["now"] == .null ? nil : try dec(c["now"])
            same(json(scheduleAlerts(items, deps, str(c["today"])!, now)), expected(c["out"]), "#\(i)")
        }
        section(fixtures, "reminders") { c, i in
            let items: [PlanItem] = try dec(c["items"])
            let now: Clock = try dec(c["now"])
            let r = reminderAlerts(items, now, c["lead"]!.int!)
            same(json(r), expected(c["out"]), "#\(i)")
            same(json(r.map { reminderSummary($0, now.date) }), expected(c["summaries"]), "#\(i) summaries")
        }
        section(fixtures, "scheduleSummary") { c, i in
            let a = c["alert"]!
            let alert = ScheduleAlert(
                key: WebhookEventKey(rawValue: a["key"]!.string!)!, daysOverdue: a["daysOverdue"]?.int,
                overrunDays: a["overrunDays"]?.int, time: a["time"]?.string
            )
            same(scheduleSummary(alert, str(c["cause"])), str(c["out"])!, "#\(i)")
        }
        section(fixtures, "remindLead") { c, _ in same(remindLeadLabel(c["m"]!.int!), str(c["out"])!, "lead \(c["m"]!.int!)") }
        section(fixtures, "incoming") { c, i in
            let opts = c["opts"]
            let r = parseIncoming(c["body"] ?? .null, "2026-11-13", timeZone: opts?["timeZone"]?.string, nowMinutes: opts?["nowMinutes"]?.int)
            let mine: JSONValue
            switch r {
            case let .ok(cmd): mine = ["ok": true, "command": cmd.json]
            case let .error(e): mine = ["ok": false, "error": .string(e)]
            }
            same(encodeKeepingNulls(mine), encodeKeepingNulls(c["out"]!), "#\(i) \(encodeKeepingNulls(c["body"] ?? .null)) \(encodeKeepingNulls(opts ?? .null))")
        }
        section(fixtures, "chat") { c, i in
            let p: WebhookPayload = try dec(c["payload"])
            same(webhookText(p), str(c["text"])!, "#\(i) text")
            same(encodeKeepingNulls(.object(chatMessage(p, .slack))), encodeKeepingNulls(c["slack"]!), "#\(i) slack")
            same(encodeKeepingNulls(.object(chatMessage(p, .discord))), encodeKeepingNulls(c["discord"]!), "#\(i) discord")
        }
        section(fixtures, "orderTimes") { c, i in
            let task: TaskItem = try dec(c["task"])
            let n = c["next"]!
            func tri(_ v: JSONValue?) -> String?? {
                guard let v else { return nil }
                return .some(v.string)
            }
            let next = TimedSpan(startDate: n["startDate"]?.string, dueDate: n["dueDate"]?.string, startTime: tri(n["startTime"]), dueTime: tri(n["dueTime"]))
            let o = orderTimes(task, next)
            var mine: [String: JSONValue] = ["startDate": .orNull(o.startDate), "dueDate": .orNull(o.dueDate)]
            if let t = o.startTime { mine["startTime"] = .orNull(t) }
            if let t = o.dueTime { mine["dueTime"] = .orNull(t) }
            same(encodeKeepingNulls(.object(mine)), encodeKeepingNulls(c["out"]!), "#\(i)")
        }
    }
}
