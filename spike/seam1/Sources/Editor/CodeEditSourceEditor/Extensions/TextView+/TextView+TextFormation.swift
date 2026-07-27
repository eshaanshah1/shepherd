//
//  TextView+TextFormation.swift
//  CodeEditSourceEditor
//
//  Created by Khan Winter on 10/14/23.
//

import Foundation
import TextStory
import TextFormation

// `TextStoring` stays on `TextView` exactly as upstream had it: none of its members
// collide, and its protocol extension supplies helpers the controller calls directly
// (`insertString`, `replaceString`, …).
//
// `TextInterface` is what cannot stay. It requires `var selectedRange`, while
// `NSTextInputClient` requires `func selectedRange()`, and Swift permits that pair on
// one type only while the two live in different modules. Vendored into a single
// module they collide, so `TextInterface` moves onto the ``TextViewInterface``
// forwarder below and `TextView` keeps its `NSTextInputClient` method.
extension TextView: @retroactive TextStoring {
    public var length: Int {
        textStorage.length
    }

    public func substring(from range: NSRange) -> String? {
        return textStorage.substring(from: range)
    }

    /// Applies the mutation to the text view.
    ///
    /// If the mutation is empty it will be ignored.
    ///
    /// - Parameter mutation: The mutation to apply.
    public func applyMutation(_ mutation: TextMutation) {
        guard !mutation.isEmpty else { return }
        _undoManager?.registerMutation(mutation)
        textStorage.replaceCharacters(in: mutation.range, with: mutation.string)
        selectionManager.didReplaceCharacters(
            in: mutation.range,
            replacementLength: (mutation.string as NSString).length
        )
        layoutManager.invalidateLayoutForRange(mutation.range)
    }
}

/// Adapts a ``TextView`` to TextFormation's `TextInterface`.
///
/// Exists only to carry `selectedRange` as a settable property without colliding with
/// `NSTextInputClient.selectedRange()` on the view itself. Everything else forwards to
/// the view's own `TextStoring` conformance above.
///
/// A class, not a struct: `TextStoring` refines `AnyObject`.
final class TextViewInterface: TextInterface {
    private let textView: TextView

    init(_ textView: TextView) { self.textView = textView }

    var selectedRange: NSRange {
        get {
            textView.selectionManager
                .textSelections
                .sorted(by: { $0.range.lowerBound < $1.range.lowerBound })
                .first?
                .range ?? .zero
        }
        set {
            textView.selectionManager.setSelectedRange(newValue)
        }
    }

    var length: Int { textView.length }

    func substring(from range: NSRange) -> String? {
        textView.substring(from: range)
    }

    func applyMutation(_ mutation: TextMutation) {
        textView.applyMutation(mutation)
    }
}
