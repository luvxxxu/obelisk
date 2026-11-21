import Foundation

// Tasks as quick-add lines (Shared/Core/TaskText.swift, web/src/lib/task-text.ts): a copied line must
// read back through parseQuickAdd as the same task, and pasted list markers must not end up in titles.

private let TODAY = "2026-11-13" // Friday

func runTaskTextTests() {
    describe("dateToken") {
        test("short within the next year, ISO beyond it") {
            expectEqual(dateToken("2026-11-22", TODAY), "11/22")
            expectEqual(dateToken("2027-03-01", TODAY), "3/1")
            expectEqual(dateToken("2028-03-01", TODAY), "2028-03-01")
        }
    }

    describe("taskLine") {
        test("title, date, time, project, priority, fixed") {
            let t = makeTask(priority: 3, dueDate: "2026-11-22", dueTime: "15:00", fixed: true, title: "견적서  보내기 ")
            expectEqual(taskLine(t, TODAY, "런칭 준비"), "견적서 보내기 11/22 15:00 #런칭_준비 !높음 @고정")
            expectEqual(taskLine(makeTask(title: "메모"), TODAY, nil), "메모")
        }

        test("a two-day span is a range; a same-day span keeps both times") {
            let range = makeTask(startDate: "2026-11-20", dueDate: "2026-11-22", title: "출장")
            expectEqual(taskLine(range, TODAY, nil), "출장 11/20~11/22")
            let timed = makeTask(startDate: "2026-11-20", startTime: "10:00", dueDate: "2026-11-20", dueTime: "11:30", title: "회의")
            expectEqual(taskLine(timed, TODAY, nil), "회의 11/20 10:00~11:30")
        }

        test("reads back through quick add as the same task") {
            let cases: [TaskItem] = [
                makeTask(priority: 2, dueDate: "2026-11-22", dueTime: "15:00", title: "견적서 보내기"),
                makeTask(startDate: "2026-11-20", dueDate: "2026-11-22", title: "출장"),
                makeTask(startDate: "2026-11-20", startTime: "10:00", dueDate: "2026-11-21", dueTime: "18:00", title: "워크숍"),
                makeTask(priority: 1, dueDate: "2027-06-01", fixed: true, title: "계약 갱신"),
            ]
            for t in cases {
                let r = parseQuickAdd(taskLine(t, TODAY, "런칭"), TODAY)
                expectEqual(r.title, t.title, t.title)
                expectEqual(r.startDate, t.startDate == t.dueDate ? nil : t.startDate, t.title)
                expectEqual(r.dueDate, t.dueDate, t.title)
                expectEqual(r.dueTime, t.dueTime, t.title)
                expectEqual(r.projectName, "런칭", t.title)
                expectEqual(r.priority ?? 0, t.priority, t.title)
                expectEqual(r.fixed, t.fixed, t.title)
            }
        }
    }

    describe("pasteLines") {
        test("drops list markers, check boxes and empty lines") {
            let text = "- 장보기 내일\r\n* 세탁\n\n• 청소 !높음\n1. 보고서 금요일\n2) 회의록\n- [ ] 할 일\n[x] 끝낸 일\n   \n-음수 아님"
            expectEqual(pasteLines(text), ["장보기 내일", "세탁", "청소 !높음", "보고서 금요일", "회의록", "할 일", "끝낸 일", "-음수 아님"])
        }

        test("one line stays one line") {
            expectEqual(pasteLines("  그냥 한 줄  "), ["그냥 한 줄"])
            expectEqual(pasteLines("\n\n"), [])
        }
    }
}
