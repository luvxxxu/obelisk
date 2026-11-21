import Foundation

// Port of packages/core/src/quickadd.ts — natural-language quick add, Korean + English.
//
//   "디자인 리뷰 내일 #런칭 !높음"        → due tomorrow, project 런칭, high priority
//   "보고서 다음주 수요일까지 p1"          → due next-week Wednesday, high priority
//   "워크숍 11/20~11/22 @고정"            → start 11/20, due 11/22, fixed
//   "Ship beta next friday #launch !2"   → due next Friday, project launch, medium
//   "치과 내일 오후 3시"                   → due tomorrow 15:00
//   "회의 금요일 10시~11시 반"              → Friday 10:00 – 11:30
//   "보고서 초안 금요일 ~2h"                 → due Friday, expected to take two hours

enum QuickAddKind: String, Codable, CaseIterable, Hashable, Sendable {
    case date, time, project, priority, fixed, estimate
}

struct QuickAddToken: Codable, Hashable, Sendable {
    var kind: QuickAddKind
    /// Exactly as typed
    var text: String
    /// Normalised value: ISO date, "HH:MM" (or "HH:MM~HH:MM"), project name, priority digit, "true", minutes
    var value: String
}

struct QuickAddResult: Codable, Hashable, Sendable {
    var title: String
    var startDate: ISODate?
    var startTime: ISOTime?
    var dueDate: ISODate?
    var dueTime: ISOTime?
    var projectName: String?
    var priority: Priority?
    var fixed: Bool
    /// "~1h30m", "~90분": minutes it should take.
    var estimateMinutes: Int? = nil
    var tokens: [QuickAddToken]
}

private let KO_WD: [String: Int] = ["일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6]
private let EN_WD: [String: Int] = [
    "sunday": 0, "monday": 1, "mon": 1, "tuesday": 2, "tue": 2, "tues": 2, "wednesday": 3, "wed": 3,
    "thursday": 4, "thu": 4, "thur": 4, "thurs": 4, "friday": 5, "fri": 5, "saturday": 6,
]
private let EN_WD_LOOSE: [String: Int] = EN_WD.merging(["sat": 6, "sun": 0]) { _, b in b }

private let PARTICLE = JSRegex("(까지|부터|에서|에)$")

/// Next occurrence strictly after today (1..7 days ahead).
private func nextWeekday(_ today: ISODate, _ wd: Int) -> ISODate {
    let diff = (wd - weekday(today) + 7) % 7
    return addDays(today, diff == 0 ? 7 : diff)
}

/// Weekday within the Monday-based week that starts at `monday`.
private func weekdayOfWeek(_ monday: ISODate, _ wd: Int) -> ISODate {
    addDays(monday, wd == 0 ? 6 : wd - 1)
}

private func addMonths(_ date: ISODate, _ months: Int) -> ISODate {
    let p = date.components(separatedBy: "-").map { Int($0) ?? 0 } + [0, 0, 0]
    let target = jsUTCDay(p[0], p[1] - 1 + months, 1)
    let last = endOfMonth(fromDay(target))
    let lastDay = Int(JS.slice(last, 8)) ?? 0
    return "\(JS.slice(last, 0, 8))\(JS.pad(min(p[2], lastDay)))"
}

private func monthDay(_ today: ISODate, _ month: Int, _ day: Int) -> ISODate? {
    let year = Int(JS.slice(today, 0, 4)) ?? 0
    var candidate = "\(year)-\(JS.pad(month))-\(JS.pad(day))"
    if !isISODate(candidate) { return nil }
    if candidate < today { candidate = "\(year + 1)-\(JS.pad(month))-\(JS.pad(day))" }
    return isISODate(candidate) ? candidate : nil
}

private let RE_KO_WEEKDAY = JSRegex("^(월|화|수|목|금|토|일)(요일|욜)$")
private let RE_KO_NEXT_WEEKDAY = JSRegex("^(?:다음\\s?주|담주|차주)\\s?(월|화|수|목|금|토|일)(?:요일|욜)?$")
private let RE_KO_THIS_WEEKDAY = JSRegex("^이번\\s?주\\s?(월|화|수|목|금|토|일)(?:요일|욜)?$")
private let RE_EN_NEXT = JSRegex("^next ([a-z]+)$")
private let RE_EN_THIS = JSRegex("^this ([a-z]+)$")
private let RE_KO_AFTER = JSRegex("^(\\d{1,3})\\s?(일|주|개월|달)\\s?(?:후|뒤)$")
private let RE_EN_IN = JSRegex("^in (\\d{1,3}) (days?|weeks?|months?)$")
private let RE_PLUS = JSRegex("^\\+(\\d{1,3})([dw]?)$")
private let RE_YMD = JSRegex("^(\\d{4})-(\\d{1,2})-(\\d{1,2})$")
private let RE_MD = JSRegex("^(\\d{1,2})[./](\\d{1,2})$")
private let RE_KO_MD = JSRegex("^(\\d{1,2})월\\s?(\\d{1,2})일$")
private let RE_KO_D = JSRegex("^(\\d{1,2})일$")

/// Parse one date phrase ("내일", "다음 주 수요일까지", "11/20", "in 3 days" …). nil when it is not one.
func parseDatePhrase(_ raw: String, _ today: ISODate) -> ISODate? {
    let s = PARTICLE.replaceFirst(JS.trim(raw).lowercased(), "")
    if s.isEmpty { return nil }

    switch s {
    case "오늘", "today", "tod":
        return today
    case "내일", "tomorrow", "tmr", "tmrw":
        return addDays(today, 1)
    case "모레":
        return addDays(today, 2)
    case "글피":
        return addDays(today, 3)
    case "주말", "이번주말", "이번 주말", "weekend", "this weekend":
        let wd = weekday(today)
        return wd == 6 || wd == 0 ? today : nextWeekday(today, 6)
    case "다음주", "다음 주", "담주", "차주", "next week":
        return addDays(startOfWeek(today), 7)
    case "이번주", "이번 주", "this week":
        let fri = weekdayOfWeek(startOfWeek(today), 5)
        return fri >= today ? fri : weekdayOfWeek(startOfWeek(today), 0)
    case "월말", "이번달말", "이번 달 말", "eom", "end of month":
        return endOfMonth(today)
    case "다음달", "다음 달", "next month":
        return addMonths("\(JS.slice(today, 0, 8))01", 1)
    default:
        break
    }

    if let m = RE_KO_WEEKDAY.exec(s) { return nextWeekday(today, KO_WD[m[1]!]!) }
    if let m = RE_KO_NEXT_WEEKDAY.exec(s) { return weekdayOfWeek(addDays(startOfWeek(today), 7), KO_WD[m[1]!]!) }
    if let m = RE_KO_THIS_WEEKDAY.exec(s) { return weekdayOfWeek(startOfWeek(today), KO_WD[m[1]!]!) }
    if let wd = EN_WD[s] { return nextWeekday(today, wd) }
    if let m = RE_EN_NEXT.exec(s), let wd = EN_WD_LOOSE[m[1]!] { return weekdayOfWeek(addDays(startOfWeek(today), 7), wd) }
    if let m = RE_EN_THIS.exec(s), let wd = EN_WD_LOOSE[m[1]!] { return weekdayOfWeek(startOfWeek(today), wd) }

    if let m = RE_KO_AFTER.exec(s) {
        let n = Int(m[1]!)!
        if m[2] == "일" { return addDays(today, n) }
        if m[2] == "주" { return addDays(today, n * 7) }
        return addMonths(today, n)
    }
    if let m = RE_EN_IN.exec(s) {
        let n = Int(m[1]!)!
        if JS.startsWith(m[2]!, "day") { return addDays(today, n) }
        if JS.startsWith(m[2]!, "week") { return addDays(today, n * 7) }
        return addMonths(today, n)
    }
    if let m = RE_PLUS.exec(s) { return addDays(today, Int(m[1]!)! * (m[2] == "w" ? 7 : 1)) }

    if let m = RE_YMD.exec(s) {
        let d = "\(m[1]!)-\(JS.padStart(m[2]!, 2, "0"))-\(JS.padStart(m[3]!, 2, "0"))"
        return isISODate(d) ? d : nil
    }
    if let m = RE_MD.exec(s) { return monthDay(today, Int(m[1]!)!, Int(m[2]!)!) }
    if let m = RE_KO_MD.exec(s) { return monthDay(today, Int(m[1]!)!, Int(m[2]!)!) }
    if let m = RE_KO_D.exec(s) {
        let day = Int(m[1]!)!
        if day < 1 || day > 31 { return nil }
        var candidate = "\(JS.slice(today, 0, 8))\(JS.pad(day))"
        if !isISODate(candidate) || candidate < today {
            let next = addMonths("\(JS.slice(today, 0, 8))01", 1)
            candidate = "\(JS.slice(next, 0, 8))\(JS.pad(day))"
        }
        return isISODate(candidate) ? candidate : nil
    }
    return nil
}

// MARK: - times

/// What was said around an hour: 오전/am, 오후/저녁/pm, 낮 (daytime), 밤 (night).
enum Meridiem: String, Codable, Hashable, Sendable {
    case am, pm, day, night
}

private let MERIDIEM_WORDS: [String: Meridiem] = [
    "오전": .am, "아침": .am, "새벽": .am, "am": .am, "a.m.": .am,
    "오후": .pm, "저녁": .pm, "pm": .pm, "p.m.": .pm,
    "낮": .day, "밤": .night,
]

/// An hour on a 12- or 24-hour clock plus what was said around it → 0–23 (24 = the end of the day).
private func hour24(_ h: Int, _ meridiem: Meridiem?) -> Int? {
    if h < 0 || h > 24 { return nil }
    if h > 12 { return meridiem == .am || h == 24 ? nil : h }
    switch meridiem {
    case .am: return h == 12 ? 0 : h
    case .pm: return h == 12 ? 12 : h + 12
    case .day: return h <= 6 ? h + 12 : h
    case .night: return h == 12 ? 24 : (h >= 5 ? h + 12 : h)
    case nil:
        // A bare "3시" is almost always the afternoon; "9시" the morning.
        return h >= 1 && h <= 6 ? h + 12 : h
    }
}

private func clock(_ h: Int?, _ m: Int) -> ISOTime? {
    guard let h, m >= 0, m <= 59 else { return nil }
    // "밤 12시", "자정까지": the end of that day.
    if h == 24 { return m == 0 ? "23:59" : nil }
    return "\(JS.pad(h)):\(JS.pad(m))"
}

/// One time phrase: "15:30", "오후 3시", "3시 반", "저녁 7시 30분", "9am", "3:30pm", "정오".
/// Returns nil for anything else, so titles like "1:1 미팅" stay titles.
func parseTimePhrase(_ raw: String, _ inherit: Meridiem? = nil) -> ISOTime? {
    parseTime(raw, inherit)?.time
}

private let RE_AT = JSRegex("^at\\s+")
private let RE_LEAD = JSRegex("^(오전|오후|아침|저녁|새벽|낮|밤)\\s?")
private let RE_TRAIL = JSRegex("\\s?(am|pm|a\\.m\\.|p\\.m\\.)$")
private let RE_HM = JSRegex("^(\\d{1,2}):(\\d{2})$")
private let RE_KO_HOUR = JSRegex("^(\\d{1,2})\\s?시(?:\\s?(반|(\\d{1,2})\\s?분))?$")
private let RE_HOUR = JSRegex("^(\\d{1,2})$")

private func parseTime(_ raw: String, _ inherit: Meridiem?) -> (time: ISOTime, meridiem: Meridiem?)? {
    var s = JS.trim(RE_AT.replaceFirst(PARTICLE.replaceFirst(JS.trim(raw).lowercased(), ""), ""))
    if s.isEmpty { return nil }
    if s == "정오" || s == "noon" { return ("12:00", .pm) }
    if s == "자정" || s == "midnight" { return ("23:59", .night) }

    var meridiem: Meridiem? = nil
    if let lead = RE_LEAD.exec(s) {
        meridiem = MERIDIEM_WORDS[lead[1]!]
        s = JS.slice(s, JS.length(lead[0]!))
    }
    let trail = RE_TRAIL.exec(s)
    if let trail {
        if meridiem != nil { return nil }
        meridiem = MERIDIEM_WORDS[trail[1]!]
        s = JS.slice(s, 0, -JS.length(trail[0]!))
    }
    let said = meridiem
    if meridiem == nil { meridiem = inherit }

    let out: ISOTime?
    if let m = RE_HM.exec(s) {
        let h = Int(m[1]!)!
        // "15:30" and "09:00" are on a 24-hour clock; a loose "3:30" reads like "3시 30분".
        let literal = said == nil && ((JS.length(m[1]!) == 2 && JS.startsWith(m[1]!, "0")) || h > 12 || h == 0)
        out = clock(literal ? h : hour24(h, meridiem), Int(m[2]!)!)
    } else if let m = RE_KO_HOUR.exec(s) {
        out = clock(hour24(Int(m[1]!)!, meridiem), m[2] == "반" ? 30 : (m[3].jsTruthy ? Int(m[3]!)! : 0))
    } else if let m = RE_HOUR.exec(s), said != nil, trail != nil {
        out = clock(hour24(Int(m[1]!)!, meridiem), 0)
    } else {
        return nil
    }
    guard let out else { return nil }
    return (out, meridiem)
}

private let RE_RANGE_SPLIT = JSRegex("~|–|(?<=\\d|시|반|분|m)-(?=\\s?\\d|오|저|아|밤|낮|새)")

/// "10:00~11:30", "오후 2시-4시", "10시~11시 반": both ends, the second inheriting the first's meridiem.
private func parseTimeRange(_ raw: String) -> (ISOTime, ISOTime)? {
    let parts = RE_RANGE_SPLIT.split(raw)
    guard parts.count == 2, !JS.trim(parts[0]).isEmpty, !JS.trim(parts[1]).isEmpty else { return nil }
    guard let a = parseTime(parts[0], nil) else { return nil }
    guard let b = parseTime(parts[1], a.meridiem) else { return nil }
    return (a.time, b.time)
}

/// A date with an optional time.
struct DateTimePhrase: Codable, Hashable, Sendable {
    var date: ISODate
    var time: ISOTime?
}

/// A date with an optional time, as typed into a date field: "내일 오후 3시", "11/20 15:30", "금요일".
func parseDateTimePhrase(_ raw: String, _ today: ISODate, _ nowMinutes: Int? = nil) -> DateTimePhrase? {
    let q = parseQuickAdd(raw, today, disabled: [.project, .priority, .fixed, .estimate], nowMinutes: nowMinutes)
    if !q.title.isEmpty || !q.dueDate.jsTruthy || q.startDate.jsTruthy { return nil }
    return DateTimePhrase(date: q.dueDate!, time: q.dueTime)
}

private let RE_P123 = JSRegex("^p([1-3])$")
private let RE_BANG = JSRegex("^!(.+)$")

private func parsePriority(_ word: String) -> Priority? {
    let w = word.lowercased()
    if w == "!!!" { return 3 }
    if w == "!!" { return 2 }
    if let m = RE_P123.exec(w) { return 4 - Int(m[1]!)! }
    guard let m = RE_BANG.exec(w) else { return nil }
    switch m[1]! {
    case "3", "높음", "긴급", "high", "h": return 3
    case "2", "보통", "중간", "medium", "med", "m": return 2
    case "1", "낮음", "low", "l": return 1
    case "0", "없음", "none": return 0
    default: return nil
    }
}

private struct Slot {
    var date: ISODate?
    var time: ISOTime?
}

private let RE_WS = JSRegex("\\s+")
private let RE_PROJECT = JSRegex("^#\\S+")
private let RE_UNDERSCORE = JSRegex("_")
private let RE_FIXED = JSRegex("^@(고정|fixed|fix)$", ignoreCase: true)
private let RE_LEADING_DIGIT = JSRegex("^\\d")

/// Parse a quick-add line. `disabled` kinds stay in the title; with `nowMinutes` (minutes past midnight
/// now), a time alone that has already passed today means tomorrow.
func parseQuickAdd(_ input: String, _ today: ISODate, disabled: [QuickAddKind] = [], nowMinutes: Int? = nil) -> QuickAddResult {
    let off = Set(disabled)
    let words = RE_WS.split(JS.trim(input)).filter { !$0.isEmpty }
    var titleWords: [String] = []
    var tokens: [QuickAddToken] = []
    /// Up to two points in time (start, due), each a date and/or a time as they were typed.
    var slots: [Slot] = []
    func canDate() -> Bool { slots.count < 2 || (slots.last != nil && !slots.last!.date.jsTruthy) }
    func canTime() -> Bool { slots.count < 2 || (slots.last != nil && !slots.last!.time.jsTruthy) }
    func addDate(_ d: ISODate) {
        if let l = slots.last, !l.date.jsTruthy, l.time.jsTruthy { slots[slots.count - 1].date = d }
        else { slots.append(Slot(date: d, time: nil)) }
    }
    func addTime(_ t: ISOTime) {
        if let l = slots.last, l.date.jsTruthy, !l.time.jsTruthy { slots[slots.count - 1].time = t }
        else { slots.append(Slot(date: nil, time: t)) }
    }
    var projectName: String? = nil
    var priority: Priority? = nil
    var fixed = false
    var estimateMinutes: Int? = nil

    var i = 0
    while i < words.count {
        let w = words[i]

        // "~2h", "~1시간 30분", "~ 45분": how long it takes.
        if !off.contains(.estimate), estimateMinutes == nil, JS.startsWith(w, "~") {
            let head = JS.slice(w, 1)
            let next: String? = i + 1 < words.count ? words[i + 1] : nil
            let one = head.isEmpty ? nil : parseDuration(head)
            let two = next.flatMap { parseDuration("\(head)\($0)") }
            let len = two != nil && (one == nil || RE_LEADING_DIGIT.test(next!)) ? 2 : one != nil ? 1 : 0
            if len > 0 {
                let minutes = len == 2 ? two! : one!
                estimateMinutes = minutes
                tokens.append(QuickAddToken(kind: .estimate, text: words[i ..< i + len].joined(separator: " "), value: String(minutes)))
                i += len
                continue
            }
        }

        if !off.contains(.project), projectName == nil, RE_PROJECT.test(w) {
            let name = RE_UNDERSCORE.replaceAll(JS.slice(w, 1), " ")
            projectName = name
            tokens.append(QuickAddToken(kind: .project, text: w, value: name))
            i += 1
            continue
        }
        if !off.contains(.priority), priority == nil, let p = parsePriority(w) {
            priority = p
            tokens.append(QuickAddToken(kind: .priority, text: w, value: String(p)))
            i += 1
            continue
        }
        if !off.contains(.fixed), RE_FIXED.test(w) {
            fixed = true
            tokens.append(QuickAddToken(kind: .fixed, text: w, value: "true"))
            i += 1
            continue
        }

        let dateOn = !off.contains(.date) && canDate()
        let timeOn = !off.contains(.time) && canTime()

        // Range in a single token: "11/20~11/22", "내일~금요일"
        if dateOn, slots.isEmpty, JS.includes(w, "~") {
            let parts = JS.split(w, "~")
            let a = parts[0]
            let b = parts.count > 1 ? parts[1] : nil
            let da = a.isEmpty ? nil : parseDatePhrase(a, today)
            let db = (b ?? "").isEmpty ? nil : parseDatePhrase(b!, today)
            if let da, let db {
                slots.append(Slot(date: da, time: nil))
                slots.append(Slot(date: db, time: nil))
                tokens.append(QuickAddToken(kind: .date, text: w, value: "\(da)~\(db)"))
                i += 1
                continue
            }
        }

        var matched = false
        var len = min(3, words.count - i)
        while len >= 1 && !matched {
            let phrase = words[i ..< i + len].joined(separator: " ")
            if dateOn, let d = parseDatePhrase(phrase, today) {
                addDate(d)
                tokens.append(QuickAddToken(kind: .date, text: phrase, value: d))
                i += len
                matched = true
                break
            }
            if timeOn {
                if let t = parseTimePhrase(phrase) {
                    addTime(t)
                    tokens.append(QuickAddToken(kind: .time, text: phrase, value: t))
                    i += len
                    matched = true
                    break
                }
                // "10시~11시", "오후 2시-4시": a span within one day.
                let range = slots.isEmpty || (slots.count == 1 && !slots[0].time.jsTruthy) ? parseTimeRange(phrase) : nil
                if let range {
                    addTime(range.0)
                    slots.append(Slot(date: nil, time: range.1))
                    tokens.append(QuickAddToken(kind: .time, text: phrase, value: "\(range.0)~\(range.1)"))
                    i += len
                    matched = true
                    break
                }
            }
            len -= 1
        }
        if matched { continue }

        titleWords.append(w)
        i += 1
    }

    // A time without a date takes the date said next to it; with none at all, the next time it comes round.
    for k in slots.indices where slots[k].date == nil {
        let prev = k > 0 ? slots[k - 1].date : nil
        slots[k].date = prev ?? slots.first(where: { $0.date.jsTruthy })?.date ?? nil
    }
    if !slots.isEmpty, slots.allSatisfy({ !$0.date.jsTruthy }) {
        let first = slots[0].time ?? "00:00"
        let hm = first.components(separatedBy: ":").map { Int($0) ?? 0 } + [0, 0]
        let passed = nowMinutes != nil && hm[0] * 60 + hm[1] <= nowMinutes!
        for k in slots.indices { slots[k].date = passed ? addDays(today, 1) : today }
    }

    var start: Slot? = nil
    var due: Slot? = nil
    if slots.count == 1 {
        due = slots[0]
    } else if slots.count >= 2 {
        func key(_ sl: Slot) -> String { "\(sl.date ?? "null")T\(sl.time ?? "")" }
        let a = slots[0]
        let b = slots[1]
        if key(a) <= key(b) { (start, due) = (a, b) } else { (start, due) = (b, a) }
    }

    return QuickAddResult(
        title: JS.trim(titleWords.joined(separator: " ")),
        startDate: start?.date,
        startTime: start?.date.jsTruthy == true ? start?.time : nil,
        dueDate: due?.date,
        dueTime: due?.date.jsTruthy == true ? due?.time : nil,
        projectName: projectName,
        priority: priority,
        fixed: fixed,
        estimateMinutes: estimateMinutes,
        tokens: tokens
    )
}

/// Anything with a name, for `matchProject` (Project, OverviewProject, Team, Member conform).
protocol HasName {
    var name: String { get }
}

extension Project: HasName {}
extension Team: HasName {}
extension Member: HasName {}

private let RE_SQUASH = JSRegex("\\s+")

/// Loose project lookup: exact → ignoring spaces → prefix → unique substring.
func matchProject<T: HasName>(_ projects: [T], _ name: String) -> T? {
    let n = JS.trim(name).lowercased()
    if n.isEmpty { return nil }
    func squash(_ s: String) -> String { RE_SQUASH.replaceAll(s.lowercased(), "") }
    let sn = squash(n)
    let contains = projects.filter { JS.includes(squash($0.name), sn) }
    return projects.first { $0.name.lowercased() == n }
        ?? projects.first { squash($0.name) == sn }
        ?? projects.first { JS.startsWith($0.name.lowercased(), n) }
        ?? (contains.count == 1 ? contains[0] : nil)
}
