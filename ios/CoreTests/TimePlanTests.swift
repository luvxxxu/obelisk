import Foundation

// Port of the duration and quick-add cases in packages/core/test/timeplan.test.ts, plus the small
// work-hour helpers the day timeline uses.

private let TODAY = "2026-11-20" // Friday

func runTimePlanTests() {
    describe("durations") {
        test("parses what people type") {
            expectEqual(parseDuration("90m"), 90)
            expectEqual(parseDuration("1.5h"), 90)
            expectEqual(parseDuration("1h30m"), 90)
            expectEqual(parseDuration("1h30"), 90)
            expectEqual(parseDuration("90분"), 90)
            expectEqual(parseDuration("1시간 30분"), 90)
            expectEqual(parseDuration("1시간반"), 90)
            expectEqual(parseDuration("2시간"), 120)
            expectEqual(parseDuration("반나절"), 240)
            expectEqual(parseDuration("하루"), 480)
            expectEqual(parseDuration("30분정도"), 30)
            expectEqual(parseDuration("45분 걸림"), 45)
            expectNil(parseDuration("30"))
            expectNil(parseDuration("3시"))
            expectNil(parseDuration("25h"))
            expectNil(parseDuration("1.5h30m"))
            expectNil(parseDuration(""))
            expectEqual(formatDurationShort(90), "1h30m")
            expectEqual(formatDurationShort(120), "2h")
            expectEqual(formatDurationShort(45), "45m")
        }

        test("quick add reads ~estimates and leaves ranges alone") {
            let a = parseQuickAdd("보고서 초안 금요일 ~2h #런칭", TODAY)
            expectEqual(a.title, "보고서 초안")
            expectEqual(a.estimateMinutes, 120)
            expectEqual(a.projectName, "런칭")
            expectTrue(a.tokens.contains { $0.kind == .estimate && $0.text == "~2h" && $0.value == "120" })

            let b = parseQuickAdd("기획 회의 준비 ~1시간 30분", TODAY)
            expectEqual(b.title, "기획 회의 준비")
            expectEqual(b.estimateMinutes, 90)

            let c = parseQuickAdd("메일 정리 ~ 45분", TODAY)
            expectEqual(c.title, "메일 정리")
            expectEqual(c.estimateMinutes, 45)

            let d = parseQuickAdd("1:1 미팅 ~30m 내일", TODAY)
            expectEqual(d.title, "1:1 미팅")
            expectEqual(d.estimateMinutes, 30)
            expectEqual(d.dueDate, "2026-11-21")

            let w = parseQuickAdd("워크숍 11/20~11/22", TODAY)
            expectEqual(w.title, "워크숍")
            expectNil(w.estimateMinutes)
            expectEqual(w.startDate, "2026-11-20")
            expectEqual(w.dueDate, "2026-11-22")

            let x = parseQuickAdd("물결 ~표시 테스트", TODAY)
            expectEqual(x.title, "물결 ~표시 테스트")
            expectNil(x.estimateMinutes)

            let r = parseQuickAdd("회의 10시 ~11시", TODAY)
            expectEqual(r.startTime, "10:00")
            expectEqual(r.dueTime, "11:00")
            expectNil(r.estimateMinutes)

            let off = parseQuickAdd("정리 ~1h", TODAY, disabled: [.estimate])
            expectEqual(off.title, "정리 ~1h")
            expectNil(off.estimateMinutes)
        }

        test("a date field never reads an estimate") {
            expectNil(parseDateTimePhrase("내일 ~1h", TODAY))
        }
    }

    describe("work hours") {
        test("intervals, workdays and free slots") {
            let h = WorkHours.standard
            expectEqual(h.minutesPerDay, 480)
            expectTrue(h.isWorkday(TODAY))
            expectFalse(h.isWorkday("2026-11-21"))
            expectEqual(
                subtractIntervals([MinuteInterval(start: 0, end: 100)], [MinuteInterval(start: 20, end: 30), MinuteInterval(start: 90, end: 120)]),
                [MinuteInterval(start: 0, end: 20), MinuteInterval(start: 30, end: 90)]
            )
            // 09:00–10:00 taken, lunch 12–13: an hour fits at 10:00; five hours only after lunch;
            // six hours nowhere, so the first gap long enough for a piece.
            let busy = [MinuteInterval(start: 540, end: 600)]
            expectEqual(nextFreeSlot(hours: h, busy: busy, from: 0, minutes: 60), MinuteInterval(start: 600, end: 660))
            expectEqual(nextFreeSlot(hours: h, busy: busy, from: 0, minutes: 300), MinuteInterval(start: 780, end: 1080))
            expectEqual(nextFreeSlot(hours: h, busy: busy, from: 0, minutes: 360), MinuteInterval(start: 600, end: 720))
            // From 14:02 the slot starts on the 5-minute grid.
            expectEqual(nextFreeSlot(hours: h, busy: [], from: 14 * 60 + 2, minutes: 30), MinuteInterval(start: 845, end: 875))
            expectNil(nextFreeSlot(hours: h, busy: [], from: 18 * 60, minutes: 30))
        }

        test("labels") {
            expectEqual(formatClock(59), "00:59")
            expectEqual(formatClock(32 * 60 + 10), "32:10")
            expectEqual(formatClock(3600 + 5 * 60 + 9), "1:05:09")
            expectEqual(percentKo(0.724), "72%")
            expectEqual(percentKo(0.855), "86%")
        }
    }

    describe("time models") {
        test("older payloads still decode") {
            let task = #"{"id":"t","workspaceId":"w","number":1,"title":"x","notes":"","status":"todo","priority":0,"projectId":null,"startDate":null,"startTime":null,"dueDate":null,"dueTime":null,"fixed":false,"position":0,"postponedCount":0,"assigneeId":null,"createdBy":null,"completedAt":null,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z"}"#
            let t = try JSONDecoder().decode(TaskItem.self, from: Data(task.utf8))
            expectNil(t.estimateMinutes)
            expectEqual(t.actual, 0)
            expectEqual(t.assigneeIds, [])
            let one = task.replacingOccurrences(of: #""assigneeId":null"#, with: #""assigneeId":"me""#)
            expectEqual(try JSONDecoder().decode(TaskItem.self, from: Data(one.utf8)).assigneeIds, ["me"])
            let withTime = task.replacingOccurrences(of: #""fixed":false"#, with: #""fixed":false,"estimateMinutes":90,"actualMinutes":40"#)
            let u = try JSONDecoder().decode(TaskItem.self, from: Data(withTime.utf8))
            expectEqual(u.estimateMinutes, 90)
            expectEqual(u.actual, 40)
        }

        test("work hours round-trip as the server expects") {
            let h = WorkHours.standard
            expectEqual(canonicalJSON(h.json), canonicalJSON(text: #"{"days":[1,2,3,4,5],"start":"09:00","end":"18:00","breaks":[{"start":"12:00","end":"13:00"}]}"#))
            let back = try JSONDecoder().decode(WorkHours.self, from: Data(#"{"days":[0,6],"start":"10:00","end":"16:00","breaks":[],"focus":0.6,"defaultEstimate":45}"#.utf8))
            expectEqual(back.focus, 0.6)
            expectEqual(back.defaultEstimate, 45)
        }

        test("running clock counts from its start") {
            let r = RunningTimer(
                entry: TimeEntry(id: "e", workspaceId: "w", taskId: "t", userId: "u", source: .timer, startedAt: "2026-11-20T01:00:00.000Z", endedAt: nil, minutes: nil, createdAt: "2026-11-20T01:00:00.000Z"),
                task: .init(id: "t", number: 3, title: "x", workspaceId: "w", projectId: nil, status: .doing, estimateMinutes: nil, actualMinutes: 0)
            )
            let now = ISO8601DateFormatter.parseServer("2026-11-20T01:32:10Z")!
            expectEqual(r.elapsed(now: now), 32 * 60 + 10)
        }
    }
}
