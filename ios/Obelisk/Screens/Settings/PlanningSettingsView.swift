import SwiftUI

/// 설정 › 일정 계획 (web settings/planning): work days, hours and breaks, how much of the day goes to tasks,
/// the estimate assumed for tasks without one, and what Obelisk has learned from the user's history.
struct PlanningSettingsView: View {
    @Environment(AppStore.self) private var store

    @State private var hours = WorkHours.standard
    @State private var synced = false
    @State private var saving = false
    @State private var learned: CalibrationSummary?

    /// Monday first, like a Korean calendar.
    private static let week = [1, 2, 3, 4, 5, 6, 0]
    private static let dayKo = ["일", "월", "화", "수", "목", "금", "토"]

    private var dirty: Bool { hours != (store.user?.hours ?? .standard) }
    private var valid: Bool {
        hours.start < hours.end && hours.breaks.allSatisfy { $0.start < $0.end && $0.start >= hours.start && $0.end <= hours.end }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                OrgSection("근무 시간", lead: "하루 계획은 이 시간 안에서 짜고, 완료 확률은 이 시간을 일할 수 있는 시간으로 봐요.") {
                    OrgCard {
                        daysRow.orgRow()
                        timeRow("시작", value: $hours.start).orgRow(vertical: ObSpace.sm)
                        timeRow("끝", value: $hours.end).orgRow(vertical: ObSpace.sm)
                    }
                }
                breaksSection
                OrgSection("집중과 예상", lead: "근무 시간 중 실제로 작업에 쓰는 비율과, 예상 시간이 없는 작업을 몇 분으로 볼지 정해요. 자동이면 기록에서 배워요.") {
                    OrgCard {
                        focusRow.orgRow()
                        estimateRow.orgRow()
                    }
                }
                learnedSection
                Button {
                    Task { await save() }
                } label: {
                    HStack(spacing: 6) {
                        if saving { ProgressView().controlSize(.small).tint(Ob.onPrimary) }
                        Text("저장")
                    }
                }
                .buttonStyle(.ob(.primary, fullWidth: true))
                .disabled(!dirty || !valid || saving)
                if !valid {
                    Text("끝 시각은 시작보다 늦고, 쉬는 시간은 근무 시간 안에 있어야 해요.")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.dangerText)
                }
            }
            .padding(.horizontal, ObSpace.page)
            .padding(.top, ObSpace.md)
            .padding(.bottom, ObSpace.xxxl)
        }
        .obPage()
        .onAppear(perform: sync)
        .task { learned = await store.calibration() }
    }

    private func sync() {
        guard !synced, let u = store.user else { return }
        hours = u.hours
        synced = true
    }

    private func save() async {
        saving = true
        defer { saving = false }
        if await store.saveWorkHours(hours) {
            Haptics.success()
            store.toasts.show("일정 계획 설정을 저장했어요")
            learned = await store.calibration()
        }
    }

    // MARK: rows

    private var daysRow: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Text("일하는 요일")
                .font(ObFont.body)
                .foregroundStyle(Ob.text)
            HStack(spacing: 6) {
                ForEach(Self.week, id: \.self) { d in
                    let on = hours.days.contains(d)
                    Button {
                        Haptics.select()
                        if on { hours.days.removeAll { $0 == d } } else { hours.days = (hours.days + [d]).sorted() }
                    } label: {
                        Text(Self.dayKo[d])
                            .font(ObFont.sub.weight(.medium))
                            .foregroundStyle(on ? Ob.onPrimary : Ob.text2)
                            .frame(width: 36, height: 36)
                            .background(on ? Ob.primary : Ob.bg, in: Circle())
                            .overlay { if !on { Circle().strokeBorder(Ob.borderStrong, lineWidth: 1) } }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(Self.dayKo[d])요일")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    private func timeRow(_ title: String, value: Binding<ISOTime>) -> some View {
        HStack {
            Text(title)
                .font(ObFont.body)
                .foregroundStyle(Ob.text)
            Spacer()
            DatePicker(title, selection: Self.dateBinding(value), displayedComponents: .hourAndMinute)
                .labelsHidden()
        }
    }

    /// "HH:MM" ⇄ a Date today (5-minute steps are enough; the picker shows minutes).
    static func dateBinding(_ value: Binding<ISOTime>) -> Binding<Date> {
        Binding(
            get: {
                let m = toMinutes(value.wrappedValue)
                return Calendar.current.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
            },
            set: { d in
                let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                value.wrappedValue = fromMinutes((c.hour ?? 0) * 60 + (c.minute ?? 0))
            }
        )
    }

    private var breaksSection: some View {
        OrgSection("쉬는 시간", lead: "점심처럼 매일 비우는 시간이에요. 이 시간에는 계획을 넣지 않아요.") {
            Button {
                let start = max(hours.start, "12:00")
                let end = fromMinutes(min(toMinutes(hours.end), toMinutes(start) + 60))
                if start < end { hours.breaks.append(TimeSpanHM(start: start, end: end)) }
            } label: {
                ListsButtonLabel(title: "추가", symbol: "plus")
            }
            .buttonStyle(.ob(.outline, size: .small))
            .disabled(hours.breaks.count >= 4)
        } content: {
            if hours.breaks.isEmpty {
                Text("쉬는 시간이 없어요")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
            } else {
                OrgCard {
                    ForEach(hours.breaks.indices, id: \.self) { i in
                        HStack(spacing: ObSpace.sm) {
                            DatePicker("시작", selection: Self.dateBinding($hours.breaks[i].start), displayedComponents: .hourAndMinute)
                                .labelsHidden()
                            Text("–").foregroundStyle(Ob.text3)
                            DatePicker("끝", selection: Self.dateBinding($hours.breaks[i].end), displayedComponents: .hourAndMinute)
                                .labelsHidden()
                            Spacer(minLength: 0)
                            Button {
                                hours.breaks.remove(at: i)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Ob.text3)
                                    .frame(width: 32, height: 32)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("쉬는 시간 지우기")
                        }
                        .orgRow(vertical: ObSpace.sm)
                    }
                }
            }
        }
    }

    private var focusRow: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Toggle(isOn: Binding(
                get: { hours.focus == nil },
                set: { auto in hours.focus = auto ? nil : (learned?.focus ?? 0.7) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("작업에 쓰는 비율").font(ObFont.body).foregroundStyle(Ob.text)
                    Text(hours.focus == nil ? "자동: 기록에서 배워요" : "직접 정함")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
            }
            if let f = hours.focus {
                HStack(spacing: ObSpace.md) {
                    Slider(value: Binding(get: { f }, set: { hours.focus = ($0 * 20).rounded() / 20 }), in: 0.1 ... 1)
                        .tint(Ob.primary)
                    Text(percentKo(f))
                        .font(ObFont.sub.monospacedDigit())
                        .foregroundStyle(Ob.text)
                        .frame(width: 48, alignment: .trailing)
                }
                Text("작업에 쓰는 시간: 하루 \(formatDurationKo(Int(Double(hours.minutesPerDay) * f)))")
                    .font(ObFont.footnote)
                    .foregroundStyle(Ob.text3)
            }
        }
    }

    private var estimateRow: some View {
        VStack(alignment: .leading, spacing: ObSpace.sm) {
            Toggle(isOn: Binding(
                get: { hours.defaultEstimate == nil },
                set: { auto in hours.defaultEstimate = auto ? nil : (learned?.defaultEstimate ?? 60) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("예상 시간이 없는 작업").font(ObFont.body).foregroundStyle(Ob.text)
                    Text(hours.defaultEstimate == nil ? "자동: 기록에서 배워요" : "직접 정함")
                        .font(ObFont.footnote)
                        .foregroundStyle(Ob.text3)
                }
            }
            if let m = hours.defaultEstimate {
                Stepper(value: Binding(get: { m }, set: { hours.defaultEstimate = min(480, max(5, $0)) }), in: 5 ... 480, step: 5) {
                    Text(formatDurationKo(m))
                        .font(ObFont.sub.monospacedDigit())
                        .foregroundStyle(Ob.text)
                }
            }
        }
    }

    // MARK: learned

    private var learnedSection: some View {
        OrgSection("지금까지 배운 것", lead: "끝낸 작업과 기록한 시간에서 계산해요. 완료 확률과 약속 날짜가 이 값을 써요.") {
            if let c = learned {
                OrgCard {
                    fact("예상 대비 실제", c.ratioSamples > 0 ? "\(String(format: "%.1f", c.medianRatio ?? 1))배 (\(c.ratioSamples)개)" : "기록 없음 · 1.25배로 봐요")
                    fact("첫 마감을 지킨 비율", c.slipSamples > 0 ? "\(percentKo(c.onTimeRate ?? 0)) (\(c.slipSamples)개)" : "기록 없음")
                    if let late = c.meanLateDays {
                        fact("늦을 때 평균", "\(String(format: "%.1f", late))일")
                    }
                    fact("작업에 쓰는 비율", "\(percentKo(c.focus)) · \(sourceKo(c.focusSource))")
                    fact("예상 없는 작업", "\(formatDurationKo(c.defaultEstimate)) · \(sourceKo(c.defaultEstimateSource))")
                }
            } else {
                LoadingView()
            }
        }
    }

    private func fact(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(ObFont.body).foregroundStyle(Ob.text2)
            Spacer(minLength: ObSpace.sm)
            Text(value).font(ObFont.body).foregroundStyle(Ob.text).multilineTextAlignment(.trailing)
        }
        .orgRow()
        .accessibilityElement(children: .combine)
    }

    private func sourceKo(_ s: String) -> String {
        switch s {
        case "setting": "직접 정함"
        case "history": "기록에서"
        case "pace": "끝내는 속도에서"
        default: "기본값"
        }
    }
}
