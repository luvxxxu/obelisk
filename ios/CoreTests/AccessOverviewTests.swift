import Foundation

// Port of packages/core/test/access.test.ts and overview.test.ts.

private struct Subject: TaskAccessSubject {
    var projectId: String?
    var createdBy: String?
    var assigneeId: String?
}

private func view(_ levels: [String: AccessLevel], _ kind: WorkspaceKind = .org) -> AccessView {
    AccessView(userId: "me", kind: kind, projectLevel: { levels[$0] })
}

func runAccessTests() {
    describe("levels") {
        test("atLeast orders view < edit < manage and treats none/nil as nothing") {
            expectTrue(atLeast(AccessLevel.edit, .view))
            expectFalse(atLeast(AccessLevel.view, .edit))
            expectTrue(atLeast(AccessLevel.manage, .manage))
            expectFalse(atLeast(MemberAccess.none, .view))
            expectFalse(atLeast(nil, .view))
        }

        test("maxLevel picks the best grant (everyone, own, team)") {
            expectEqual(maxLevel(MemberAccess.none, AccessLevel.view, nil), .view)
            expectEqual(maxLevel(AccessLevel.view, AccessLevel.manage, AccessLevel.edit), .manage)
            expectNil(maxLevel(MemberAccess.none, nil))
            expectEqual(maxLevel(MemberAccess.edit, AccessLevel.view), .edit)
        }
    }

    describe("task access") {
        let a = view(["p1": .view, "p2": .edit])

        test("project tasks follow the project level") {
            expectEqual(taskAccess(Subject(projectId: "p1", createdBy: "me", assigneeId: "me"), a), .view)
            expectFalse(canEditTask(Subject(projectId: "p1", createdBy: "me", assigneeId: "me"), a))
            expectTrue(canEditTask(Subject(projectId: "p2", createdBy: "x", assigneeId: nil), a))
            expectFalse(canViewTask(Subject(projectId: "p3", createdBy: "me", assigneeId: "me"), a))
        }

        test("org inbox tasks are private to their creator and assignee") {
            expectTrue(canEditTask(Subject(projectId: nil, createdBy: "me", assigneeId: nil), a))
            expectTrue(canEditTask(Subject(projectId: nil, createdBy: "x", assigneeId: "me"), a))
            expectFalse(canViewTask(Subject(projectId: nil, createdBy: "x", assigneeId: "y"), a))
        }

        test("everything in a personal space is yours") {
            expectEqual(taskAccess(Subject(projectId: nil, createdBy: "x", assigneeId: nil), view([:], .personal)), .manage)
        }

        test("access from the projects the server sent; canWriteProject") {
            let p = Project(
                id: "p9", workspaceId: "w", name: "P", color: .blue, position: 1, archivedAt: nil, access: .edit,
                memberAccess: .view, createdBy: nil, createdAt: "", updatedAt: ""
            )
            let av = AccessView(userId: "me", kind: .org, projects: [p])
            expectTrue(canEditTask(makeTask(projectId: "p9"), av))
            expectTrue(canWriteProject("p9", [p]))
            expectTrue(canWriteProject(nil, [p]))
            expectFalse(canWriteProject("other", [p]))
            expectTrue(isWorkspaceAdmin(.admin))
            expectFalse(isWorkspaceAdmin(.member))
            expectFalse(isWorkspaceAdmin(nil))
        }
    }

    describe("activity phrases") {
        test("field changes read as arrows") {
            let text = describeActivity(action: "task.updated", data: [
                "changes": ["dueDate": ["from": "2026-11-20", "to": "2026-11-23"], "status": ["from": "todo", "to": "done"]],
            ], subject: "#3 개발")
            expectContains(text, "마감일 11/20")
            expectContains(text, "11/23")
            expectContains(text, "완료")
        }

        test("sharing changes name who got what") {
            let text = describeActivity(action: "project.access", data: [
                "changes": [["everyone": ["from": "none", "to": "view"]], ["member": "김민지", "from": nil, "to": "edit"]],
            ], subject: "런칭")
            expectEqual(text, "공유 설정 · 조직 전체 권한 없음 → 보기 · 김민지 권한 없음 → 쓰기")
        }
    }
}

private let OV_TODAY = "2026-11-17"
private var ovSeq = 0

private func task(
    status: TaskStatus = .todo, startDate: String? = nil, dueDate: String? = nil, fixed: Bool = false, assigneeId: String? = nil,
    createdBy: String? = "me"
) -> TaskItem {
    ovSeq += 1
    return makeTask(
        id: "t\(ovSeq)", number: ovSeq, status: status, startDate: startDate, dueDate: dueDate, fixed: fixed,
        position: Double(ovSeq), assigneeId: assigneeId, createdBy: createdBy, title: "task \(ovSeq)"
    )
}

func runOverviewTests() {
    describe("whose work") {
        test("personal space: everything; organization: only what is assigned to me") {
            expectTrue(isMine(task(), .personal, "me"))
            expectTrue(isMine(task(assigneeId: "me"), .org, "me"))
            expectFalse(isMine(task(assigneeId: "kim"), .org, "me"))
            expectFalse(isMine(task(assigneeId: nil, createdBy: "me"), .org, "me"))
            expectFalse(isMine(task(assigneeId: nil), .org, ""))
        }

        test("org tasks of teammates never make it in, whatever their date") {
            expectFalse(inOverview(task(dueDate: OV_TODAY, assigneeId: "kim"), .org, "me", OV_TODAY))
            expectTrue(inOverview(task(dueDate: OV_TODAY, assigneeId: "me"), .org, "me", OV_TODAY))
        }
    }

    describe("which dates") {
        func inn(_ t: TaskItem) -> Bool { inOverview(t, .personal, "me", OV_TODAY) }

        test("overdue, today, started, in progress and the next 7 days are in") {
            expectTrue(inn(task(dueDate: "2026-11-10")))
            expectTrue(inn(task(dueDate: OV_TODAY)))
            expectTrue(inn(task(startDate: "2026-11-15", dueDate: "2026-11-30")))
            expectTrue(inn(task(status: .doing)))
            expectTrue(inn(task(dueDate: "2026-11-24")))
            expectFalse(inn(task(dueDate: "2026-11-25")))
            expectFalse(inn(task()))
        }

        test("closed tasks are out") {
            expectFalse(inn(task(status: .done, dueDate: OV_TODAY)))
            expectFalse(inn(task(status: .canceled, dueDate: OV_TODAY)))
        }

        test("fixed commitments count up to 30 days ahead") {
            expectTrue(inn(task(dueDate: "2026-12-10", fixed: true)))
            expectFalse(inn(task(dueDate: "2026-12-18", fixed: true)))
            expectFalse(inn(task(dueDate: "2026-12-10")))
        }

        test("fixedDate: a start still ahead, else the last day; nothing once it is over") {
            expectEqual(fixedDate(task(startDate: "2026-11-20", dueDate: "2026-11-22", fixed: true), OV_TODAY), "2026-11-20")
            expectEqual(fixedDate(task(startDate: "2026-11-15", dueDate: "2026-11-22", fixed: true), OV_TODAY), "2026-11-22")
            expectNil(fixedDate(task(dueDate: "2026-11-16", fixed: true), OV_TODAY))
            expectNil(fixedDate(task(dueDate: "2026-11-20"), OV_TODAY))
        }
    }

    describe("sections") {
        test("each task lands in exactly one list; fixed ones are also listed apart") {
            let overdue = task(dueDate: "2026-11-12")
            let today = task(dueDate: OV_TODAY)
            let doing = task(status: .doing, dueDate: "2026-11-20")
            let fri = task(dueDate: "2026-11-20")
            let meeting = task(dueDate: "2026-11-19", fixed: true)
            let far = task(dueDate: "2026-12-05", fixed: true)
            let s = overviewSections([far, fri, meeting, doing, today, overdue], OV_TODAY)

            expectEqual(s.overdue.map(\.id), [overdue.id])
            expectEqual(s.today.map(\.id), [doing.id, today.id])
            expectEqual(s.week.count, OVERVIEW_DAYS)
            expectEqual(s.week[0].date, "2026-11-18")
            expectEqual(s.week.first { $0.date == "2026-11-19" }!.tasks.map(\.id), [meeting.id])
            expectEqual(s.week.first { $0.date == "2026-11-20" }!.tasks.map(\.id), [fri.id])
            expectEqual(s.fixed.map { "\($0.task.id)@\($0.date)" }, ["\(meeting.id)@2026-11-19", "\(far.id)@2026-12-05"])
            let listed = s.overdue + s.today + s.week.flatMap(\.tasks)
            expectEqual(Set(listed.map(\.id)).count, listed.count)
        }

        test("a task due after the week but starting inside it waits for its due date (as on Upcoming)") {
            let s = overviewSections([task(startDate: "2026-11-19", dueDate: "2026-11-28")], OV_TODAY)
            expectTrue(s.week.allSatisfy { $0.tasks.isEmpty })
        }

        test("OverviewTask decodes flat JSON and works with the same functions") {
            let json = #"{"id":"x","workspaceId":"w","number":4,"title":"보고서","notes":"","status":"todo","priority":2,"projectId":null,"startDate":null,"startTime":null,"dueDate":"2026-11-17","dueTime":"15:00","fixed":false,"position":1,"postponedCount":0,"assigneeId":"me","createdBy":"me","completedAt":null,"createdAt":"","updatedAt":"","editable":true}"#
            let t = try JSONDecoder().decode(OverviewTask.self, from: Data(json.utf8))
            expectEqual(t.title, "보고서")
            expectTrue(t.editable)
            expectTrue(inOverview(t, .org, "me", OV_TODAY))
            expectEqual(overviewSections([t], OV_TODAY).today.map(\.id), ["x"])
            let again = try JSONDecoder().decode(OverviewTask.self, from: JSONEncoder().encode(t))
            expectEqual(again, t)
        }
    }

    describe("overview merge (web/src/lib/overview.ts)") {
        test("open space live, other spaces from the fetch, cache newer than the fetch wins") {
            let personal = WorkspaceSummary(id: "p", kind: .personal, name: "개인", role: .owner, memberCount: 1)
            let org = WorkspaceSummary(id: "o", kind: .org, name: "팀", role: .member, memberCount: 3)
            let org2 = WorkspaceSummary(id: "o2", kind: .org, name: "팀2", role: .member, memberCount: 3)
            expectEqual(spaceHues([personal, org, org2]), ["p": .slate, "o": .blue, "o2": .violet])

            var remote = makeTask(id: "r1", dueDate: OV_TODAY)
            remote.workspaceId = "o"
            let data = Overview(today: OV_TODAY, spaces: [personal, org], tasks: [OverviewTask(task: remote, editable: false)], projects: [])
            let mine = makeTask(id: "l1", dueDate: OV_TODAY)
            let open = OverviewOpenSpace(workspace: personal, userId: "me", today: OV_TODAY, tasks: [mine, makeTask(id: "later", dueDate: "2027-01-01")], projects: [])
            var cache: [String: OverviewLiveCacheEntry] = [:]
            let t0 = Date(timeIntervalSince1970: 1000)
            let m = mergeOverview(data, fetchedAt: t0, open: open, workspaces: [], liveCache: &cache, now: t0.addingTimeInterval(5))
            expectEqual(m.items.map(\.id), ["l1", "r1"])
            expectEqual(m.items.map(\.live), [true, false])
            expectEqual(m.items.map(\.editable), [true, false])
            expectEqual(cache["p"]?.items.map(\.id), ["l1"])

            // Switched to the org: personal rows come from the newer live cache.
            let openOrg = OverviewOpenSpace(workspace: org, userId: "me", today: OV_TODAY, tasks: [], projects: [])
            let m2 = mergeOverview(data, fetchedAt: t0, open: openOrg, workspaces: [], liveCache: &cache, now: t0.addingTimeInterval(9))
            expectEqual(m2.items.map(\.id), ["l1"])
            expectEqual(m2.items.map(\.live), [false])
        }
    }
}
