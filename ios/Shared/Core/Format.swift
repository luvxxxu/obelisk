import Foundation

// Port of web/src/lib/format.ts (labels and tones for task rows) plus `completedOn` from
// web/src/lib/hooks.ts. `cx` (CSS class joining) has no Swift counterpart.

/// How a task's date should look.
enum DateTone: String, Codable, CaseIterable, Hashable, Sendable {
    case overdue, today, soon, `default`, done
}

/// With `now`, a due time that passed today already counts as overdue.
func dateTone<T: ViewTask>(_ task: T, _ today: ISODate, _ now: Clock? = nil) -> DateTone {
    if task.status == .done || task.status == .canceled { return .done }
    guard let d = task.dueDate ?? task.startDate, !d.isEmpty else { return .default }
    if let due = task.dueDate, !due.isEmpty {
        if due < today { return .overdue }
        if let now, now.date == today, isPastDue(due, task.dueTime, now) { return .overdue }
    }
    if d == today { return .today }
    if let s = task.startDate, !s.isEmpty, s <= today {
        if !task.dueDate.jsTruthy || task.dueDate! >= today { return .today }
    }
    if diffDays(d, today) <= 2 { return .soon }
    return .default
}

/// "오늘 오후 3:00" (or the label alone without a time).
func withTime(_ label: String, _ time: ISOTime?) -> String {
    guard let time, !time.isEmpty else { return label }
    return "\(label) \(formatTimeKo(time))"
}

/// "오늘", "내일 오후 3:00", "금요일 오전 10:00 – 11:30", "11월 20일 (목)",
/// ranges as "11/18 (화) – 11/20 (목) 오후 6:00", running ones as "금요일 오후 6:00까지".
func spanLabel<T: TimedSpanLike>(_ task: T, _ today: ISODate) -> String? {
    let s = task.startDate.jsTruthy ? task.startDate : nil
    let d = task.dueDate.jsTruthy ? task.dueDate : nil
    let st = s != nil ? (task.startTime ?? nil) : nil
    let dt = d != nil ? (task.dueTime ?? nil) : nil
    if let s, let d, s != d {
        if s <= today && d >= today { return "\(withTime(formatRelativeKo(d, today), dt))까지" }
        return "\(formatShortKo(s)) – \(withTime(formatShortKo(d), dt))"
    }
    if s != nil, let d, st.jsTruthy, dt.jsTruthy { return "\(formatRelativeKo(d, today)) \(formatTimeRangeKo(st!, dt!))" }
    if s != nil, let d, st.jsTruthy { return "\(withTime(formatRelativeKo(d, today), st))부터" }
    guard let one = task.dueDate ?? task.startDate, !one.isEmpty else { return nil }
    return withTime(formatRelativeKo(one, today), d != nil ? dt : st)
}

/// Inside a day group the header names the day: rows say only the time ("오후 3:00", "오전 10:00 – 11:30").
func timeLabel<T: TimedSpanLike>(_ task: T) -> String? {
    let st = task.startDate.jsTruthy ? task.startTime : nil
    let dt = task.dueDate.jsTruthy ? task.dueTime : nil
    if st.jsTruthy, dt.jsTruthy, task.startDate == task.dueDate { return formatTimeRangeKo(st!, dt!) }
    if dt.jsTruthy { return formatTimeKo(dt!) }
    if st.jsTruthy && (!task.dueDate.jsTruthy || task.startDate == task.dueDate) { return formatTimeKo(st!) }
    return nil
}

/// "3일 지남", "어제 마감", or for a time that passed today "40분 지남".
func overdueLabel(_ due: ISODate, _ today: ISODate, _ dueTime: ISOTime? = nil, _ now: Clock? = nil) -> String {
    let n = diffDays(today, due)
    if n <= 0, let dueTime, !dueTime.isEmpty, let now { return "\(formatDurationKo(now.minutes - toMinutes(dueTime))) 지남" }
    if n <= 0 { return "마감 지남" }
    return n == 1 ? "어제 마감" : "\(n)일 지남"
}

/// "40분 남음" when a timed due falls within the next hour, else nil.
func dueSoonLabel<T: ViewTask>(_ task: T, _ now: Clock) -> String? {
    if task.status == .done || task.status == .canceled { return nil }
    guard let due = task.dueDate, !due.isEmpty, let time = task.dueTime, !time.isEmpty else { return nil }
    let left = minutesUntil(due, time, now)
    return left > 0 && left <= 60 ? "\(formatDurationKo(left)) 남음" : nil
}

/// "3일", "2주"
func daysLabel(_ n: Int) -> String {
    formatDaysKo(n)
}

/// "11월 20일 목요일"
func longDateKo(_ date: ISODate) -> String {
    let p = date.components(separatedBy: "-").map { Int($0) ?? 0 } + [0, 0, 0]
    let day = jsUTCDay(p[0], p[1] - 1, p[2])
    let wd = WEEKDAYS_KO[(((day + 4) % 7) + 7) % 7]
    return "\(p[1])월 \(p[2])일 \(wd)요일"
}

/// "방금 전", "5분 전", "3시간 전", "2일 전", then the date ("2026. 11. 13."); "사용 기록 없음" for nil.
/// The date is read in `timeZone` (the device's, like the browser's `toLocaleDateString('ko-KR')`).
func relativeTime(_ iso: String?, now: Date = Date(), timeZone: TimeZone = .current) -> String {
    guard let iso, !iso.isEmpty else { return "사용 기록 없음" }
    guard let date = JS.parseDate(iso) else { return "Invalid Date" }
    let diff = now.timeIntervalSince(date)
    if diff < 60 { return "방금 전" }
    if diff < 3600 { return "\(Int((diff / 60).rounded(.down)))분 전" }
    if diff < 86400 { return "\(Int((diff / 3600).rounded(.down)))시간 전" }
    if diff < 86400 * 30 { return "\(Int((diff / 86400).rounded(.down)))일 전" }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone
    let c = cal.dateComponents([.year, .month, .day], from: date)
    return "\(c.year ?? 0). \(c.month ?? 0). \(c.day ?? 0)."
}

/// The day (in time zone `tz`) a task was completed; nil when it isn't, or the timestamp can't be read.
func completedOn(_ t: TaskItem, _ tz: String) -> ISODate? {
    guard let at = t.completedAt, !at.isEmpty, let date = JS.parseDate(at) else { return nil }
    return todayIn(tz, now: date)
}
