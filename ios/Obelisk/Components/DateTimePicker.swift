import SwiftUI

/// Pick a date (and optionally a time): quick picks (오늘 · 내일 · 이번 주말 · 다음 주), a typed phrase
/// ("다음 주 금요일", "11/20", "내일 오후 3시"), the system calendar and an optional time.
/// The web's DatePickerPanel + TimePickerPanel as one sheet.
///
///     router.present(.init(id: "due", detents: [.medium, .large]) {
///         DateTimePickerSheet(title: "마감", date: t.dueDate, time: t.dueTime, today: store.today) { d, tm in … }
///     })
struct DateTimePickerSheet: View {
    var title: String
    var date: ISODate?
    var time: ISOTime?
    var today: ISODate
    /// Offer a time row (start/due on tasks); off for plain date fields.
    var allowsTime = true
    /// Offer "날짜 지우기".
    var clearable = true
    /// The earliest allowed date (e.g. a due date can't be before the start), if any.
    var minDate: ISODate?
    var onPick: (ISODate?, ISOTime?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked: Date = .now
    @State private var hasTime = false
    @State private var timeValue: Date = .now
    @State private var phrase = ""
    @State private var phraseError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ObSpace.lg) {
                    phraseField
                    quickPicks
                    DatePicker("날짜", selection: $picked, in: lowerBound..., displayedComponents: .date)
                        .datePickerStyle(.graphical)
                        .environment(\.locale, Locale(identifier: "ko_KR"))
                        .tint(Ob.primary)
                    if allowsTime { timeRow }
                }
                .padding(.horizontal, ObSpace.page)
                .padding(.bottom, ObSpace.xxl)
            }
            .obPage()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("설정") { commit(picked) }
                        .fontWeight(.semibold)
                }
                if clearable, date != nil {
                    ToolbarItem(placement: .bottomBar) {
                        Button("날짜 지우기", role: .destructive) {
                            onPick(nil, nil)
                            dismiss()
                        }
                        .foregroundStyle(Ob.dangerText)
                    }
                }
            }
        }
        .onAppear {
            picked = DayMath.date(from: date ?? today) ?? .now
            if let time, let t = DayMath.time(from: time) {
                hasTime = true
                timeValue = t
            } else {
                timeValue = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: .now) ?? .now
            }
        }
    }

    private var lowerBound: Date {
        DayMath.date(from: minDate ?? "1970-01-01") ?? .distantPast
    }

    private var phraseField: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("다음 주 금요일, 내일 오후 3시…", text: $phrase)
                .textFieldStyle(.ob)
                .submitLabel(.done)
                .onSubmit(applyPhrase)
                .accessibilityLabel("날짜 입력 (예: 다음 주 금요일, 11/20, 내일 오후 3시)")
            if let phraseError {
                Text(phraseError).font(ObFont.footnote).foregroundStyle(Ob.dangerText)
            }
        }
        .padding(.top, ObSpace.sm)
    }

    private var quickPicks: some View {
        let options: [(String, String, ISODate)] = [
            ("오늘", "sun.max", today),
            ("내일", "arrow.right", DayMath.add(today, 1)),
            ("이번 주말", "calendar", DayMath.weekend(today)),
            ("다음 주", "calendar", DayMath.nextMonday(today)),
        ]
        return HStack(spacing: ObSpace.sm) {
            ForEach(options, id: \.0) { o in
                Button {
                    commit(DayMath.date(from: o.2) ?? .now)
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: o.1).font(.system(size: 15))
                        Text(o.0).font(ObFont.footnote.weight(.medium))
                    }
                    .foregroundStyle(Ob.text)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(Ob.surface2, in: RoundedRectangle(cornerRadius: ObRadius.md))
                }
                .buttonStyle(.plain)
                .disabled(minDate.map { o.2 < $0 } ?? false)
            }
        }
    }

    private var timeRow: some View {
        VStack(spacing: 0) {
            Toggle(isOn: $hasTime.animation(ObMotion.standard)) {
                Label("시간", systemImage: "clock")
                    .font(ObFont.body)
                    .foregroundStyle(Ob.text)
            }
            .tint(Ob.primary)
            .frame(minHeight: ObSize.row)
            if hasTime {
                DatePicker("시각", selection: $timeValue, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                    .environment(\.locale, Locale(identifier: "ko_KR"))
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, ObSpace.md)
        .obCard(padding: 0, radius: ObRadius.md)
    }

    private func applyPhrase() {
        let text = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let r = DatePhrase.parse(text, today: today) else {
            phraseError = "날짜를 알아듣지 못했어요"
            return
        }
        if let minDate, r.date < minDate {
            phraseError = "고를 수 없는 날짜예요"
            return
        }
        phraseError = nil
        picked = DayMath.date(from: r.date) ?? picked
        if let t = r.time, let d = DayMath.time(from: t) {
            hasTime = true
            timeValue = d
        }
        commit(picked)
    }

    private func commit(_ d: Date) {
        let iso = DayMath.iso(d)
        let t: ISOTime? = allowsTime && hasTime ? DayMath.isoTime(timeValue) : (allowsTime ? nil : time)
        onPick(iso, t)
        dismiss()
    }
}

/// Calendar-date helpers for SwiftUI controls: ISODate strings ↔ local `Date`s at midnight.
/// (Arithmetic on plan dates lives in Shared/Core/Dates.swift; this only bridges to pickers.)
enum DayMath {
    private static var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        c.firstWeekday = 1
        return c
    }

    static func date(from iso: ISODate) -> Date? {
        let p = iso.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    static func iso(_ d: Date) -> ISODate {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    static func time(from t: ISOTime) -> Date? {
        let p = t.split(separator: ":").compactMap { Int($0) }
        guard p.count == 2 else { return nil }
        return cal.date(bySettingHour: p[0], minute: p[1], second: 0, of: .now)
    }

    static func isoTime(_ d: Date) -> ISOTime {
        let c = cal.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    static func add(_ iso: ISODate, _ days: Int) -> ISODate {
        guard let d = date(from: iso), let n = cal.date(byAdding: .day, value: days, to: d) else { return iso }
        return self.iso(n)
    }

    /// 0 = Sunday … 6 = Saturday
    static func weekday(_ iso: ISODate) -> Int {
        guard let d = date(from: iso) else { return 0 }
        return cal.component(.weekday, from: d) - 1
    }

    /// This Saturday (today when it is Saturday or Sunday).
    static func weekend(_ today: ISODate) -> ISODate {
        let w = weekday(today)
        if w == 6 || w == 0 { return today }
        return add(today, 6 - w)
    }

    static func nextMonday(_ today: ISODate) -> ISODate {
        let w = weekday(today)
        return add(today, w == 0 ? 1 : 8 - w)
    }
}

/// A typed date phrase ("다음 주 금요일", "11/20", "내일 오후 3시"), parsed like the web's date field.
enum DatePhrase {
    static func parse(_ text: String, today: ISODate, timezone: String? = nil) -> DateTimePhrase? {
        let now = nowIn(timezone ?? TimeZone.current.identifier)
        return parseDateTimePhrase(text, today, now.date == today ? now.minutes : nil)
    }
}
