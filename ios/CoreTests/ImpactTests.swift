import Foundation

// Port of packages/core/test/impact.test.ts and order.test.ts.

private func T(_ id: String, _ startDate: String?, _ dueDate: String?, status: TaskStatus = .todo, fixed: Bool = false) -> PlanItem {
    PlanItem(id: id, title: id, status: status, startDate: startDate, dueDate: dueDate, fixed: fixed, projectId: "p1")
}

private func D(_ taskId: String, _ dependsOnId: String) -> PlanDependency {
    PlanDependency(taskId: taskId, dependsOnId: dependsOnId)
}

private func byId(_ r: ImpactReport, _ id: String) -> TaskImpact? { r.impacts.first { $0.taskId == id } }

func runImpactTests() {
    describe("simulate") {
        let items = [
            T("A", "2026-11-16", "2026-11-17"),
            T("B", "2026-11-18", "2026-11-20"),
            T("C", "2026-11-23", "2026-11-23", fixed: true),
        ]
        let deps = [D("B", "A"), D("C", "B")]

        test("small slip is pushed into B and absorbed by C") {
            let r = simulate(items, deps, ["A": 3])
            let a = try unwrap(byId(r, "A"))
            expectEqual(a.kind, .root)
            expectEqual(a.shiftDays, 3)
            expectEqual(a.to, DateSpan(startDate: "2026-11-19", dueDate: "2026-11-20"))
            let b = try unwrap(byId(r, "B"))
            expectEqual(b.kind, .shifted)
            expectEqual(b.shiftDays, 2)
            expectEqual(b.to, DateSpan(startDate: "2026-11-20", dueDate: "2026-11-22"))
            expectEqual(b.viaId, "A")
            expectEqual(b.depth, 1)
            let c = try unwrap(byId(r, "C"))
            expectEqual(c.kind, .absorbed)
            expectEqual(c.slackDays, 1)
            expectEqual(c.depth, 2)
            expectEqual(r.summary.delayedCount, 1)
            expectEqual(r.summary.conflictCount, 0)
        }

        test("bigger slip collides with the fixed task") {
            let r = simulate(items, deps, ["A": 5])
            expectEqual(byId(r, "B")?.kind, .shifted)
            expectEqual(byId(r, "B")?.shiftDays, 4)
            let c = try unwrap(byId(r, "C"))
            expectEqual(c.kind, .conflict)
            expectEqual(c.overrunDays, 1)
            expectEqual(c.shiftDays, 0)
            expectEqual(r.summary.conflictCount, 1)
            expectEqual(r.summary.projectSlips, [ProjectSlip(projectId: "p1", from: "2026-11-23", to: "2026-11-24", shiftDays: 1)])
        }

        test("slack absorbs the delay entirely") {
            let r = simulate([T("A", nil, "2026-11-16"), T("B", "2026-11-20", "2026-11-21")], [D("B", "A")], ["A": 2])
            expectEqual(byId(r, "B")?.kind, .absorbed)
            expectEqual(byId(r, "B")?.slackDays, 2)
            expectEqual(r.summary.delayedCount, 0)
        }

        test("pre-existing violations are not amplified") {
            let r = simulate([T("A", nil, "2026-11-18"), T("B", "2026-11-16", "2026-11-17")], [D("B", "A")], ["A": 1])
            expectEqual(byId(r, "B")?.kind, .shifted)
            expectEqual(byId(r, "B")?.shiftDays, 1)
        }

        test("done predecessors neither move nor constrain") {
            let r = simulate([T("A", nil, "2026-11-16", status: .done), T("B", nil, "2026-11-17")], [D("B", "A")], ["A": 5])
            expectEqual(r.impacts.count, 0)
        }

        test("diamond takes the worst path") {
            let r = simulate(
                [
                    T("A", nil, "2026-11-16"),
                    T("B", "2026-11-16", "2026-11-17"),
                    T("C", "2026-11-19", "2026-11-19"),
                    T("D", "2026-11-20", "2026-11-20"),
                ],
                [D("B", "A"), D("C", "A"), D("D", "B"), D("D", "C")],
                ["A": 4]
            )
            expectEqual(byId(r, "B")?.shiftDays, 4)
            expectEqual(byId(r, "C")?.shiftDays, 1)
            expectEqual(byId(r, "D")?.shiftDays, 1)
            expectEqual(byId(r, "D")?.viaId, "B")
        }

        test("unscheduled tasks pass the delay through") {
            let r = simulate(
                [T("A", nil, "2026-11-16"), T("U", nil, nil), T("C", "2026-11-17", "2026-11-17")],
                [D("U", "A"), D("C", "U")],
                ["A": 3]
            )
            expectEqual(byId(r, "U")?.kind, .unscheduled)
            expectEqual(byId(r, "U")?.shiftDays, 3)
            expectEqual(byId(r, "C")?.kind, .shifted)
            expectEqual(byId(r, "C")?.shiftDays, 2)
            expectEqual(byId(r, "C")?.viaId, "U")
        }

        test("simulateDelay with a target date") {
            let r = try simulateDelay(items, deps, taskId: "A", toDate: "2026-11-20")
            expectEqual(byId(r, "A")?.shiftDays, 3)
            expectTrue((try? simulateDelay(items, deps, taskId: "nope", days: 1)) == nil, "unknown task throws")
        }

        test("changesFromReport respects cascade") {
            let r = simulate(items, deps, ["A": 5])
            expectEqual(changesFromReport(r, true).map(\.taskId), ["A", "B"])
            expectEqual(changesFromReport(r, false).map(\.taskId), ["A"])
        }
    }

    describe("previewDateChange") {
        let items = [T("A", "2026-11-16", "2026-11-18"), T("B", "2026-11-19", "2026-11-20")]
        let deps = [D("B", "A")]

        test("extending a due date pushes dependents; the edited task keeps its exact new span") {
            let p = previewDateChange(items, deps, "A", DateSpan(startDate: "2026-11-16", dueDate: "2026-11-21"))
            expectEqual(p.shiftDays, 3)
            expectTrue(p.hasImpact)
            expectEqual(p.cascade, [
                DateChange(taskId: "A", startDate: "2026-11-16", dueDate: "2026-11-21"),
                DateChange(taskId: "B", startDate: "2026-11-21", dueDate: "2026-11-22"),
            ])
            expectEqual(p.only.count, 1)
        }

        test("pulling a task in front of its blocker is flagged") {
            let p = previewDateChange(items, deps, "B", DateSpan(startDate: "2026-11-16", dueDate: "2026-11-17"))
            expectEqual(p.startsBeforeBlockers, [BlockerWarning(taskId: "A", title: "A", number: nil, dueDate: "2026-11-18", overlapDays: 2)])
            expectTrue(p.hasImpact)
        }

        test("moving earlier within slack is harmless") {
            let p = previewDateChange(items, deps, "B", DateSpan(startDate: "2026-11-18", dueDate: "2026-11-19"))
            expectEqual(p.startsBeforeBlockers.count, 0)
            expectFalse(p.hasImpact)
        }
    }

    describe("forecast") {
        test("a past start date alone is not \"late\"") {
            let r = forecast([T("S", "2026-11-10", nil), T("N", "2026-11-11", "2026-11-12")], [D("N", "S")], "2026-11-13")
            expectEqual(r.rootIds, ["N"])
        }

        test("overdue work finishes today at the earliest") {
            let r = forecast(
                [T("A", nil, "2026-11-10"), T("B", "2026-11-12", "2026-11-14"), T("Z", nil, "2026-11-20")],
                [D("B", "A")],
                "2026-11-13"
            )
            expectEqual(r.rootIds, ["A"])
            expectEqual(byId(r, "A")?.kind, .root)
            expectEqual(byId(r, "A")?.shiftDays, 3)
            expectEqual(byId(r, "B")?.kind, .shifted)
            expectEqual(byId(r, "B")?.shiftDays, 1)
        }
    }

    describe("graph helpers") {
        test("cycle detection") {
            let deps = [D("B", "A"), D("C", "B")]
            expectTrue(wouldCreateCycle(deps, "A", "C"))
            expectFalse(wouldCreateCycle(deps, "C", "A"))
            expectTrue(wouldCreateCycle(deps, "A", "A"))
            expectEqual(Set(downstreamOf(deps, "A")), ["B", "C"])
        }

        test("leverage ranks bottlenecks") {
            let items = [
                T("A", nil, "2026-11-16"),
                T("B", "2026-11-16", "2026-11-17"),
                T("C", "2026-11-17", "2026-11-18", fixed: true),
                T("X", nil, "2026-11-16"),
                T("Y", "2026-11-25", "2026-11-25"),
            ]
            let lv = leverage(items, [D("B", "A"), D("C", "B"), D("Y", "X")])
            expectEqual(lv[0], TaskLeverage(taskId: "A", downstreamCount: 2, slackDays: 0, delayedIfLate: 1, conflictsIfLate: 1))
            let x = try unwrap(lv.first { $0.taskId == "X" })
            expectEqual(x.slackDays, 9)
            expectEqual(x.delayedIfLate, 0)
        }
    }

    describe("DateChange JSON") {
        test("times are tri-state: omitted, null or set") {
            let keep = DateChange(taskId: "t", startDate: nil, dueDate: "2026-11-20")
            expectEqual(canonicalJSON(keep), canonicalJSON(text: #"{"taskId":"t","dueDate":"2026-11-20"}"#))
            let data = try JSONEncoder().encode(DateChange(taskId: "t", startDate: nil, dueDate: "2026-11-20", dueTime: .some(nil)))
            let text = String(decoding: data, as: UTF8.self)
            expectContains(text, "\"dueTime\":null")
            expectContains(text, "\"startDate\":null")
            expectFalse(text.contains("startTime"))
            let back = try JSONDecoder().decode(DateChange.self, from: data)
            expectEqual(back.dueTime, .some(nil))
            expectEqual(back.startTime, nil)
        }
    }

    // order.test.ts
    describe("positionBetween") {
        test("empty list") { expectEqual(positionBetween(), POSITION_STEP) }

        test("top and bottom step away from the neighbour") {
            expectEqual(positionBetween(nil, 2048), 1024)
            expectEqual(positionBetween(2048, nil), 3072)
            expectEqual(positionBetween(nil, 0), -POSITION_STEP)
        }

        test("midpoint between neighbours") {
            expectEqual(positionBetween(1024, 2048), 1536)
            let p = positionBetween(1, 1.5)!
            expectTrue(p > 1 && p < 1.5)
        }

        test("no room → nil so the caller renumbers") {
            expectNil(positionBetween(5, 5))
            expectNil(positionBetween(5, 4))
            expectNil(positionBetween(5, 5 + 1e-9))
        }

        test("repeated inserts at the same spot stay ordered for a long time") {
            var lo = 1024.0
            let hi = 2048.0
            for _ in 0 ..< 30 {
                let p = try unwrap(positionBetween(lo, hi))
                expectTrue(p > lo && p < hi)
                lo = p
            }
        }
    }

    describe("spread") {
        test("evenly spaced, in order") {
            expectEqual(spread(["a", "b", "c"]), [
                SpreadItem(id: "a", position: 1024), SpreadItem(id: "b", position: 2048), SpreadItem(id: "c", position: 3072),
            ])
        }
    }
}
