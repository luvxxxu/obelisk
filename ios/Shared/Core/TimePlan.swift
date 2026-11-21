import Foundation

// Port of the pure helpers in packages/core/src/timeplan.ts the app needs on device: reading a typed
// duration ("1h30m", "1시간 반"), work-hour arithmetic for the day timeline, and short labels.
// Planning itself (planDay) and the finish-date odds run on the server; the app renders their answers.

/// Estimate chips offered in the apps, in minutes.
let ESTIMATE_PRESETS = [15, 30, 60, 90, 120, 240]

private let RE_DUR_SPACES = JSRegex("\\s+")
private let RE_DUR_TRAIL = JSRegex("(정도|쯤|걸림|소요)$")
private let RE_DUR_HOURS = JSRegex("^(\\d{1,2}(?:\\.\\d{1,2})?)(?:h|hr|hrs|hour|hours|시간)(?:(\\d{1,2})(?:m|min|mins|분)?|(반))?$")
private let RE_DUR_MINUTES = JSRegex("^(\\d{1,4})(?:m|min|mins|minutes?|분)$")

/// A length of time as people type it: "90m", "1.5h", "1h30m", "90분", "1시간 30분", "1시간반",
/// "2시간", "반나절", "하루". Returns minutes, or nil for anything else (a bare number included).
func parseDuration(_ raw: String) -> Int? {
    let s = RE_DUR_TRAIL.replaceFirst(RE_DUR_SPACES.replaceAll(JS.trim(raw).lowercased(), ""), "")
    if s.isEmpty { return nil }
    if s == "반나절" { return 240 }
    if s == "하루" || s == "1일" { return 480 }
    if s == "반시간" { return 30 }
    if let m = RE_DUR_HOURS.exec(s) {
        let h = Double(m[1]!) ?? 0
        let extra = m[3] != nil ? 30 : (m[2].flatMap { Int($0) } ?? 0)
        if m[2] != nil, m[1]!.contains(".") || extra > 59 { return nil }
        let total = Int(JS.round(h * 60 + Double(extra)))
        return total >= 1 && total <= 24 * 60 ? total : nil
    }
    if let m = RE_DUR_MINUTES.exec(s) {
        let total = Int(m[1]!) ?? 0
        return total >= 1 && total <= 24 * 60 ? total : nil
    }
    return nil
}

/// "1h30m" style, for round trips into quick add.
func formatDurationShort(_ minutes: Int) -> String {
    let m = max(0, minutes)
    let h = m / 60
    let r = m % 60
    if h == 0 { return "\(r)m" }
    return r != 0 ? "\(h)h\(r)m" : "\(h)h"
}

/// "1:05:09" / "32:10" for a running clock.
func formatClock(_ seconds: Int) -> String {
    let s = max(0, seconds)
    let h = s / 3600
    let m = (s % 3600) / 60
    let r = s % 60
    return h > 0 ? "\(h):\(JS.pad(m)):\(JS.pad(r))" : "\(JS.pad(m)):\(JS.pad(r))"
}

/// "85%"
func percentKo(_ p: Double) -> String { "\(Int(JS.round(p * 100)))%" }

// MARK: - work hours

/// A half-open interval of minutes in one day, [start, end).
struct MinuteInterval: Hashable, Sendable {
    var start: Int
    var end: Int
}

/// `free` minus every interval in `busy` (merged, in order).
func subtractIntervals(_ free: [MinuteInterval], _ busy: [MinuteInterval]) -> [MinuteInterval] {
    func merged(_ list: [MinuteInterval]) -> [MinuteInterval] {
        var out: [MinuteInterval] = []
        for i in list.filter({ $0.end > $0.start }).sorted(by: { $0.start < $1.start }) {
            if let last = out.last, i.start <= last.end {
                out[out.count - 1].end = max(last.end, i.end)
            } else {
                out.append(i)
            }
        }
        return out
    }
    var out = merged(free)
    for b in merged(busy) {
        var next: [MinuteInterval] = []
        for f in out {
            if b.end <= f.start || b.start >= f.end {
                next.append(f)
            } else {
                if b.start > f.start { next.append(MinuteInterval(start: f.start, end: b.start)) }
                if b.end < f.end { next.append(MinuteInterval(start: b.end, end: f.end)) }
            }
        }
        out = next
    }
    return out
}

extension WorkHours {
    /// Mon–Fri 09:00–18:00 with lunch 12–13, nothing learned yet (core DEFAULT_WORK_HOURS).
    static let standard = WorkHours(
        days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00",
        breaks: [TimeSpanHM(start: "12:00", end: "13:00")], focus: nil, defaultEstimate: nil
    )

    func isWorkday(_ date: ISODate) -> Bool { days.contains(weekday(date)) }

    /// Working intervals of a day (start–end minus breaks).
    var intervals: [MinuteInterval] {
        subtractIntervals(
            [MinuteInterval(start: toMinutes(start), end: toMinutes(end))],
            breaks.map { MinuteInterval(start: toMinutes($0.start), end: toMinutes($0.end)) }
        )
    }

    var minutesPerDay: Int { intervals.reduce(0) { $0 + $1.end - $1.start } }
}

/// The first gap of at least `minutes` (or the longest one that is at least `min(minutes, 25)`) in a
/// day's working hours, after `from`, around what is already there. nil when nothing fits.
func nextFreeSlot(hours: WorkHours, busy: [MinuteInterval], from: Int, minutes: Int) -> MinuteInterval? {
    let start = Int((Double(from) / 5).rounded(.up)) * 5
    let free = subtractIntervals(hours.intervals, busy + [MinuteInterval(start: 0, end: start)])
    if let f = free.first(where: { $0.end - $0.start >= minutes }) {
        return MinuteInterval(start: f.start, end: f.start + minutes)
    }
    if let f = free.first(where: { $0.end - $0.start >= min(minutes, 25) }) {
        return MinuteInterval(start: f.start, end: f.end)
    }
    return nil
}
