import SwiftUI
import UIKit

/// The system's left-edge pan (UIScreenEdgePanGestureRecognizer) for SwiftUI.
///
/// Opening the sidebar with a SwiftUI DragGesture on a strip inside the sliding page measured the drag in
/// the page's own coordinates; the page moved with the finger, so the measured distance shrank, the page
/// jumped back, and the two fed each other (visible flicker). This recognizer reports the translation in
/// window coordinates, only begins on a swipe from the screen edge, and never swallows taps near the edge.
struct EdgePanGesture: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    /// Translation to the right so far (≥ 0), in points.
    var onChanged: (CGFloat) -> Void
    /// Final translation and horizontal velocity (points per second).
    var onEnded: (_ translation: CGFloat, _ velocity: CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let g = UIScreenEdgePanGestureRecognizer()
        g.edges = .left
        g.delegate = context.coordinator
        return g
    }

    /// A swipe that starts at the edge belongs to the sidebar, not to the list row under the finger
    /// (rows also swipe right, to complete). Other pans wait for this one to fail, which happens at
    /// once for any touch that doesn't start at the edge.
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && !(other is UIScreenEdgePanGestureRecognizer)
        }
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let t = recognizer.translation(in: nil).x
        switch recognizer.state {
        case .began, .changed:
            onChanged(max(0, t))
        case .ended:
            onEnded(t, recognizer.velocity(in: nil).x)
        case .cancelled, .failed:
            onEnded(0, 0)
        default:
            break
        }
    }
}

extension UIApplication {
    /// Put the keyboard away (opening the sidebar over a focused composer, for example).
    @MainActor
    static func endEditing() {
        shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
