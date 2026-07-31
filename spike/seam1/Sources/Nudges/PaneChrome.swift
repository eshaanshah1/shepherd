import SwiftUI

/// A pane's chrome slot above its content.
///
/// The bar is **always** in the tree; whether it draws is the bar's own business. Making
/// the *content*'s position depend on a condition would put it inside a
/// `_ConditionalContent`, and a live libghostty surface cannot survive that: flipping the
/// flag rebuilds the subtree, `makeNSView` runs again, and the previous PTY — with whatever
/// was running in it — hangs up.
struct PaneChrome<Bar: View, Content: View>: View {
    @ViewBuilder var bar: () -> Bar
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            bar()
            content()
        }
    }
}
