import Foundation

// Port of packages/core/test/quickadd.test.ts.

private let TODAY = "2026-11-13" // Friday

private struct Named: HasName, Equatable {
    var name: String
}

func runQuickAddTests() {
    describe("parseQuickAdd") {
        test("korean basics") {
            let r = parseQuickAdd("디자인 리뷰 내일 #런칭 !높음", TODAY)
            expectEqual(r.title, "디자인 리뷰")
            expectEqual(r.dueDate, "2026-11-14")
            expectEqual(r.projectName, "런칭")
            expectEqual(r.priority, 3)
            expectEqual(r.fixed, false)
            expectEqual(r.tokens.map(\.kind), [.date, .project, .priority])
        }

        test("next-week weekday with particle") {
            let r = parseQuickAdd("보고서 다음주 수요일까지 p1", TODAY)
            expectEqual(r.title, "보고서")
            expectEqual(r.dueDate, "2026-11-18")
            expectEqual(r.priority, 3)
            expectEqual(parseQuickAdd("보고서 다음 주 수요일", TODAY).dueDate, "2026-11-18")
        }

        test("range and fixed") {
            let r = parseQuickAdd("워크숍 11/20~11/22 @고정", TODAY)
            expectEqual(r.title, "워크숍")
            expectEqual(r.startDate, "2026-11-20")
            expectEqual(r.dueDate, "2026-11-22")
            expectEqual(r.fixed, true)
            let m = parseQuickAdd("이사 준비 내일부터 금요일까지", TODAY)
            expectEqual(m.title, "이사 준비")
            expectEqual(m.startDate, "2026-11-14")
            expectEqual(m.dueDate, "2026-11-20")
        }

        test("english") {
            let r = parseQuickAdd("Ship beta next friday #launch !2", TODAY)
            expectEqual(r.title, "Ship beta")
            expectEqual(r.dueDate, "2026-11-20")
            expectEqual(r.projectName, "launch")
            expectEqual(r.priority, 2)
            expectEqual(parseQuickAdd("call mom in 3 days", TODAY).dueDate, "2026-11-16")
        }

        test("weekday on the same weekday means next week") {
            expectEqual(parseQuickAdd("정산 금요일", TODAY).dueDate, "2026-11-20")
        }

        test("relative and absolute") {
            expectEqual(parseQuickAdd("3일 후 회의", TODAY).dueDate, "2026-11-16")
            let r = parseQuickAdd("11월 25일 마감 보고", TODAY)
            expectEqual(r.title, "마감 보고")
            expectEqual(r.dueDate, "2026-11-25")
            expectEqual(parseQuickAdd("세금 1/10", TODAY).dueDate, "2027-01-10")
            expectEqual(parseQuickAdd("월말 정산", TODAY).dueDate, "2026-11-30")
        }

        test("disabled kinds stay in the title") {
            let r = parseQuickAdd("오늘 할 일 정리", TODAY, disabled: [.date])
            expectEqual(r.title, "오늘 할 일 정리")
            expectNil(r.dueDate)
        }

        test("project matching is forgiving but not ambiguous") {
            let ps = [Named(name: "제품 런칭"), Named(name: "개인"), Named(name: "블로그 운영"), Named(name: "블로그 디자인")]
            expectEqual(matchProject(ps, "런칭")?.name, "제품 런칭")
            expectEqual(matchProject(ps, "제품런칭")?.name, "제품 런칭")
            expectEqual(matchProject(ps, "개")?.name, "개인")
            expectEqual(matchProject(ps, "블로그")?.name, "블로그 운영")
            expectEqual(matchProject(ps, "디자인")?.name, "블로그 디자인")
            expectNil(matchProject(ps, "없음"))
        }

        test("plain text is untouched") {
            let r = parseQuickAdd("그냥 메모", TODAY)
            expectEqual(r.title, "그냥 메모")
            expectNil(r.dueDate)
            expectEqual(r.tokens, [])
        }
    }
}
