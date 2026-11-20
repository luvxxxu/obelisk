import SwiftUI

/// The operators' announcement (서버 관리 → 공지; web AppShell NoticeBanner): one quiet line under the top
/// bar, a hairline under it, neutral ink. Closing it hides this one on this device; a changed
/// announcement shows again.
struct NoticeBanner: View {
    @Environment(AppStore.self) private var store
    /// `at` of the announcement last closed here.
    @AppStorage("obelisk.notice-dismissed", store: AppGroup.defaults) private var dismissed = ""

    var body: some View {
        if let notice = store.server.announcement, notice.at != dismissed {
            HStack(alignment: .firstTextBaseline, spacing: ObSpace.sm) {
                Image(systemName: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(Ob.text2)
                Text(notice.text)
                    .font(ObFont.sub)
                    .foregroundStyle(Ob.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Button {
                    withAnimation(ObMotion.standard) { dismissed = notice.at }
                    Haptics.tap()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Ob.text3)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .padding(.vertical, -6)
                .accessibilityLabel("공지 닫기")
            }
            .padding(.leading, ObSpace.page)
            .padding(.trailing, ObSpace.md)
            .padding(.vertical, 10)
            .background(Ob.tint)
            .background(Ob.bg)
            .overlay(alignment: .bottom) { Hairline() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("공지")
            .transition(.opacity)
        }
    }
}
