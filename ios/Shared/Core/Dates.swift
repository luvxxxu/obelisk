import Foundation

// Port of packages/core/src/dates.ts.
//
// Calendar-date helpers. Obelisk stores plan dates as plain ISO dates ("YYYY-MM-DD") with no time or
// zone, so all arithmetic happens on "day numbers" (days since the Unix epoch, UTC) to stay DST-proof.
//
// Where the TypeScript throws on a malformed date or time (`toDay`, `toMinutes`), the Swift port does not
// trap: it reads what it can (missing numbers count as 0). Server data is always valid.

let DAY_MS = 86_400_000

// MARK: - civil calendar (proleptic Gregorian, like JS Date)

/// Days since 1970-01-01 for a proleptic Gregorian y-m-d (Howard Hinnant's algorithm).
private func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (m + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

/// (year, month 1–12, day 1–31) for a day number.
private func civilFromDays(_ z0: Int) -> (Int, Int, Int) {
    let z = z0 + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    return (m <= 2 ? y + 1 : y, m, d)
}

/// `Date.UTC(year, monthIndex, day) / DAY_MS`, with JS's overflow rules (and its 0–99 → 1900s year rule).
func jsUTCDay(_ year: Int, _ monthIndex: Int, _ day: Int) -> Int {
    var y = year
    if (0 ... 99).contains(y) { y += 1900 }
    let carry = Int((Double(monthIndex) / 12).rounded(.down))
    let mi = ((monthIndex % 12) + 12) % 12
    return daysFromCivil(y + carry, mi + 1, 1) + day - 1
}

/// The three numbers of "YYYY-MM-DD" when it has that exact shape (ASCII digits), else nil.
private func isoParts(_ value: String) -> (Int, Int, Int)? {
    let u = Array(value.utf16)
    guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D else { return nil }
    var nums = [0, 0, 0]
    let ranges = [0 ..< 4, 5 ..< 7, 8 ..< 10]
    for (k, r) in ranges.enumerated() {
        var n = 0
        for i in r {
            let c = u[i]
            guard c >= 0x30, c <= 0x39 else { return nil }
            n = n * 10 + Int(c - 0x30)
        }
        nums[k] = n
    }
    return (nums[0], nums[1], nums[2])
}

/// `date.split('-').map(Number)` for the first parts of a date-ish string (non-numbers read as 0).
private func looseParts(_ date: String) -> [Int] {
    date.components(separatedBy: "-").map { Int($0) ?? 0 }
}

// MARK: - dates

func isISODate(_ value: String) -> Bool {
    guard let (y, mo, d) = isoParts(value) else { return false }
    let (yy, mm, dd) = civilFromDays(jsUTCDay(y, mo - 1, d))
    return yy == y && mm == mo && dd == d
}

func isISODate(_ value: String?) -> Bool {
    guard let value else { return false }
    return isISODate(value)
}

/// Days since 1970-01-01 (UTC). Overflowing parts roll over like `Date.UTC` ("2026-02-30" → 2026-03-02).
func toDay(_ date: ISODate) -> Int {
    if let (y, mo, d) = isoParts(date) { return jsUTCDay(y, mo - 1, d) }
    let p = looseParts(date) + [0, 0, 0]
    return jsUTCDay(p[0], p[1] - 1, p[2])
}

func fromDay(_ day: Int) -> ISODate {
    let (y, m, d) = civilFromDays(day)
    return "\(y)-\(JS.pad(m))-\(JS.pad(d))"
}

func addDays(_ date: ISODate, _ days: Int) -> ISODate {
    fromDay(toDay(date) + days)
}

/// a - b in days
func diffDays(_ a: ISODate, _ b: ISODate) -> Int {
    toDay(a) - toDay(b)
}

/// 0 = Sunday … 6 = Saturday
func weekday(_ date: ISODate) -> Int {
    (((toDay(date) + 4) % 7) + 7) % 7
}

private func gregorian(_ zone: TimeZone) -> Calendar {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = zone
    return cal
}

/// The date on the wall clock of an IANA time zone (falls back to UTC for an unknown zone).
func todayIn(_ timeZone: String = "UTC", now: Date = Date()) -> ISODate {
    nowIn(timeZone, now: now).date
}

func isValidTimeZone(_ tz: String) -> Bool {
    TimeZone(identifier: tz) != nil
}

/// Monday-based start of week
func startOfWeek(_ date: ISODate) -> ISODate {
    let wd = weekday(date)
    let offset = wd == 0 ? -6 : 1 - wd
    return addDays(date, offset)
}

func endOfMonth(_ date: ISODate) -> ISODate {
    let p = looseParts(date) + [0, 0]
    return fromDay(jsUTCDay(p[0], p[1], 0))
}

func minDate(_ a: ISODate?, _ b: ISODate?) -> ISODate? {
    guard a.jsTruthy else { return b }
    guard b.jsTruthy else { return a }
    return a! < b! ? a : b
}

func maxDate(_ a: ISODate?, _ b: ISODate?) -> ISODate? {
    guard a.jsTruthy else { return b }
    guard b.jsTruthy else { return a }
    return a! > b! ? a : b
}

let WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"]

/// "오늘", "내일", "어제", "금요일", "11월 20일 (목)", "2027년 1월 3일 (일)"
func formatRelativeKo(_ date: ISODate, _ today: ISODate) -> String {
    let diff = diffDays(date, today)
    if diff == 0 { return "오늘" }
    if diff == 1 { return "내일" }
    if diff == 2 { return "모레" }
    if diff == -1 { return "어제" }
    let wd = WEEKDAYS_KO[weekday(date)]
    if diff > 2 && diff < 7 { return "\(wd)요일" }
    let p = looseParts(date) + [0, 0, 0]
    let ty = (looseParts(today) + [0]).first ?? 0
    if p[0] == ty { return "\(p[1])월 \(p[2])일 (\(wd))" }
    return "\(p[0])년 \(p[1])월 \(p[2])일 (\(wd))"
}

/// "11/20 (목)"
func formatShortKo(_ date: ISODate) -> String {
    let p = looseParts(date) + [0, 0, 0]
    return "\(p[1])/\(p[2]) (\(WEEKDAYS_KO[weekday(date)]))"
}

/// "3일", "2주"
func formatDaysKo(_ days: Int) -> String {
    let a = abs(days)
    if a >= 7 && a % 7 == 0 { return "\(a / 7)주" }
    return "\(a)일"
}

// MARK: - times of day

/// Minutes in a day.
let DAY_MINUTES = 1440

private func timeParts(_ value: String) -> (Int, Int)? {
    let u = Array(value.utf16)
    guard u.count == 5, u[2] == 0x3A else { return nil }
    for i in [0, 1, 3, 4] where !(u[i] >= 0x30 && u[i] <= 0x39) { return nil }
    let h = Int(u[0] - 0x30) * 10 + Int(u[1] - 0x30)
    let m = Int(u[3] - 0x30) * 10 + Int(u[4] - 0x30)
    guard h <= 23, m <= 59 else { return nil }
    return (h, m)
}

/// "HH:MM" on a 24-hour clock, 00:00–23:59.
func isISOTime(_ value: String) -> Bool { timeParts(value) != nil }

func isISOTime(_ value: String?) -> Bool {
    guard let value else { return false }
    return isISOTime(value)
}

/// "15:30" → 930 (malformed → 0; the TypeScript throws)
func toMinutes(_ time: ISOTime) -> Int {
    guard let (h, m) = timeParts(time) else { return 0 }
    return h * 60 + m
}

/// 930 → "15:30" (clamped to the day)
func fromMinutes(_ minutes: Int) -> ISOTime {
    let m = min(DAY_MINUTES - 1, max(0, minutes))
    return "\(JS.pad(m / 60)):\(JS.pad(m % 60))"
}

/// Where a wall clock in some time zone stands: its date and minutes past midnight.
struct Clock: Codable, Hashable, Sendable {
    var date: ISODate
    var minutes: Int

    init(date: ISODate, minutes: Int) {
        self.date = date
        self.minutes = minutes
    }
}

/// The wall clock of an IANA time zone at `now` (falls back to UTC for an unknown zone).
func nowIn(_ timeZone: String = "UTC", now: Date = Date()) -> Clock {
    if let zone = TimeZone(identifier: timeZone) { return nowIn(zone, now: now) }
    let ms = Int((now.timeIntervalSince1970 * 1000).rounded(.down))
    let day = Int((Double(ms) / Double(DAY_MS)).rounded(.down))
    return Clock(date: fromDay(day), minutes: (ms - day * DAY_MS) / 60_000)
}

/// The wall clock of a `TimeZone` at `now`.
func nowIn(_ zone: TimeZone, now: Date = Date()) -> Clock {
    let c = gregorian(zone).dateComponents([.year, .month, .day, .hour, .minute], from: now)
    let y = c.year ?? 1970
    let date = "\(JS.pad(y, 4))-\(JS.pad(c.month ?? 1))-\(JS.pad(c.day ?? 1))"
    return Clock(date: date, minutes: ((c.hour ?? 0) % 24) * 60 + (c.minute ?? 0))
}

/// Minutes since the epoch on the wall clock: a plain number to compare and subtract.
func clockIndex(_ date: ISODate, _ minutes: Int) -> Int {
    toDay(date) * DAY_MINUTES + minutes
}

/// Minutes from `now` until `date time` (negative once it has passed).
func minutesUntil(_ date: ISODate, _ time: ISOTime, _ now: Clock) -> Int {
    clockIndex(date, toMinutes(time)) - clockIndex(now.date, now.minutes)
}

/// Has a due date (and time) passed? Without a time the whole day counts, so it is only past from the
/// next day on; with one, it is past from that minute.
func isPastDue(_ dueDate: ISODate, _ dueTime: ISOTime?, _ now: Clock) -> Bool {
    if dueDate != now.date { return dueDate < now.date }
    guard let dueTime, !dueTime.isEmpty else { return false }
    return toMinutes(dueTime) <= now.minutes
}

/// How `dateTimeKey` fills in a missing time.
enum DateTimeKeyMissing: String, Codable, Hashable, Sendable {
    /// Beginning of the day ("00:00").
    case start
    /// End of the day ("24:00"), after every real time.
    case end
}

/// Sort key for a date and an optional time. A time-less due date counts as the end of its day, a
/// time-less start date as its beginning.
func dateTimeKey(_ date: ISODate, _ time: ISOTime?, _ missing: DateTimeKeyMissing = .end) -> String {
    "\(date)T\(time ?? (missing == .end ? "24:00" : "00:00"))"
}

/// Start must not come after due: by date, and by time when both fall on the same day.
func spanInOrder(_ startDate: ISODate?, _ startTime: ISOTime?, _ dueDate: ISODate?, _ dueTime: ISOTime?) -> Bool {
    guard startDate.jsTruthy, dueDate.jsTruthy, let s = startDate, let d = dueDate else { return true }
    if s != d { return s < d }
    guard startTime.jsTruthy, dueTime.jsTruthy, let st = startTime, let dt = dueTime else { return true }
    return st <= dt
}

/// "오전 9:05", "오후 3:00", "오후 12:30"
func formatTimeKo(_ time: ISOTime) -> String {
    let total = toMinutes(time)
    let h = total / 60
    let m = JS.pad(total % 60)
    let h12 = h % 12 == 0 ? 12 : h % 12
    return "\(h < 12 ? "오전" : "오후") \(h12):\(m)"
}

/// "오전 10:00 – 11:30", "오전 11:00 – 오후 1:00"
func formatTimeRangeKo(_ from: ISOTime, _ to: ISOTime) -> String {
    let a = formatTimeKo(from)
    let b = formatTimeKo(to)
    return JS.slice(a, 0, 2) == JS.slice(b, 0, 2) ? "\(a) – \(JS.slice(b, 3))" : "\(a) – \(b)"
}

/// "40분", "1시간", "2시간 15분", "3일"
func formatDurationKo(_ minutes: Int) -> String {
    let a = abs(minutes)
    if a < 60 { return "\(max(1, a))분" }
    if a < DAY_MINUTES {
        let h = a / 60
        let m = a % 60
        return m != 0 ? "\(h)시간 \(m)분" : "\(h)시간"
    }
    return "\(a / DAY_MINUTES)일"
}
