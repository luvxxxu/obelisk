import Foundation

// Port of web/src/lib/task-text.ts: tasks as plain lines and back. A copied line reads like something
// typed into quick add (`견적서 보내기 11/22 15:00 #런칭 !높음`), so pasting it, here, on the web or into a
// chat, says the same thing.
//
// What a line cannot carry: a start date without a due date (it comes back as the due date), and a
// same-day start time without a due time; notes, assignee and status stay out on purpose.

private let PRIORITY_TOKEN: [Int: String] = [3: "!높음", 2: "!보통", 1: "!낮음"]
private let RE_SPACES = JSRegex("\\s+")
private let RE_NEWLINE = JSRegex("\\r?\\n")
/// List markers people paste along with the text: `- `, `* `, `• `, `1. `, `2) `, `[ ] `, `- [x] `.
private let RE_MARKER = JSRegex("^\\s*(?:[-*•·]\\s+|\\d{1,3}[.)]\\s+)?(?:\\[[ xX]?\\]\\s*)?")

/// The shortest way to write `date` that quick add reads back as the same day: `11/22` within the next
/// year, else `2027-03-01`.
func dateToken(_ date: ISODate, _ today: ISODate) -> String {
    let parts = date.split(separator: "-")
    guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) else { return date }
    let short = "\(m)/\(d)"
    return parseDatePhrase(short, today) == date ? short : date
}

/// One task as a quick-add line. `projectName` nil = 인박스 (no token).
func taskLine(_ t: TaskItem, _ today: ISODate, _ projectName: String?) -> String {
    var parts = [JS.trim(RE_SPACES.replaceAll(t.title, " "))]
    let start = t.startDate
    let due = t.dueDate
    if let start, let due, start != due {
        // Two days: a range when neither end has a time, otherwise each end with its own time.
        if t.startTime == nil, t.dueTime == nil {
            parts.append("\(dateToken(start, today))~\(dateToken(due, today))")
        } else {
            parts.append(dateToken(start, today))
            if let s = t.startTime { parts.append(s) }
            parts.append(dateToken(due, today))
            if let d = t.dueTime { parts.append(d) }
        }
    } else if let day = due ?? start {
        parts.append(dateToken(day, today))
        if start == due, let s = t.startTime, let d = t.dueTime {
            parts.append("\(s)~\(d)")
        } else if let time = t.dueTime ?? t.startTime {
            parts.append(time)
        }
    }
    if let projectName { parts.append("#" + RE_SPACES.replaceAll(JS.trim(projectName), "_")) }
    if let p = PRIORITY_TOKEN[t.priority] { parts.append(p) }
    if t.fixed { parts.append("@고정") }
    return parts.joined(separator: " ")
}

/// Pasted text → one candidate task title (with quick-add tokens) per non-empty line.
func pasteLines(_ text: String) -> [String] {
    RE_NEWLINE.split(text)
        .map { JS.trim(RE_MARKER.replaceFirst($0, "")) }
        .filter { !$0.isEmpty }
}
