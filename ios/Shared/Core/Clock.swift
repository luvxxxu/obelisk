import Foundation

// Port of the non-React parts of web/src/lib/clock.ts: the user's wall clock (date + minutes past
// midnight in their time zone). The web ticks it on the minute; in SwiftUI use TimelineView(.everyMinute)
// or a timer with `nextMinuteDelay`, and read `clockNow` on each tick.

/// The wall clock now in the user's zone (`User.timezone`), or the device's zone when nil.
func clockNow(_ timeZone: String? = nil, now: Date = Date()) -> Clock {
    if let timeZone, !timeZone.isEmpty { return nowIn(timeZone, now: now) }
    return nowIn(TimeZone.current, now: now)
}

/// Seconds until just after the next minute boundary (the web waits 50 ms past it).
func nextMinuteDelay(_ now: Date = Date()) -> TimeInterval {
    let ms = (now.timeIntervalSince1970 * 1000).rounded(.down)
    let rest = ms.truncatingRemainder(dividingBy: 60_000)
    return (60_000 - rest + 50) / 1000
}
