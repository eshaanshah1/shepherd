//
//  TextViewDelegate.swift
//  CodeEditTextView
//
//  Created by Khan Winter on 9/3/23.
//

import Foundation

public protocol TextViewDelegate: AnyObject {
    func textView(_ textView: TextView, willReplaceContentsIn range: NSRange, with string: String)
    func textView(_ textView: TextView, didReplaceContentsIn range: NSRange, with string: String)
    func textView(_ textView: TextView, shouldReplaceContentsIn range: NSRange, with string: String) -> Bool
    /// Text to put on the pasteboard for a copy of `range`, or nil to copy the document's
    /// own characters.
    ///
    /// A Shepherd addition. A diff shows content the document does not contain — removed
    /// lines are drawn bands, since a removed line exists in no file and so has no row —
    /// and copying a selection that spans one would silently omit it.
    func textView(_ textView: TextView, stringForCopyOf range: NSRange) -> String?
}

public extension TextViewDelegate {
    func textView(_ textView: TextView, willReplaceContentsIn range: NSRange, with string: String) { }
    func textView(_ textView: TextView, didReplaceContentsIn range: NSRange, with string: String) { }
    func textView(_ textView: TextView, shouldReplaceContentsIn range: NSRange, with string: String) -> Bool { true }
    func textView(_ textView: TextView, stringForCopyOf range: NSRange) -> String? { nil }
}
