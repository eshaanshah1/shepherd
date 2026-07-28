//
//  TextView+CopyPaste.swift
//  CodeEditTextView
//
//  Created by Khan Winter on 8/21/23.
//

import AppKit

extension TextView {
    @objc open func copy(_ sender: AnyObject) {
        guard let selections = selectionManager?.textSelections, !selections.isEmpty else {
            return
        }
        // A Shepherd addition: the delegate gets to say what a selection copies as, because
        // a diff draws content the document does not contain — removed lines are bands, not
        // rows, so copying across one would silently drop it.
        let substituted = selections.map { delegate?.textView(self, stringForCopyOf: $0.range) }
        guard substituted.contains(where: { $0 != nil }) else {
            let attributed = selections.map { textStorage.attributedSubstring(from: $0.range) }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects(attributed)
            return
        }
        // Plain strings once anything is substituted: the reconstructed lines have no
        // attributed counterpart in the storage to carry syntax colours from.
        let strings = zip(selections, substituted).map { selection, replacement in
            replacement ?? textStorage.attributedSubstring(from: selection.range).string
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(strings.joined(separator: "\n"), forType: .string)
    }

    @objc open func paste(_ sender: AnyObject) {
        guard let stringContents = NSPasteboard.general.string(forType: .string) else { return }
        insertText(stringContents, replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    @objc open func cut(_ sender: AnyObject) {
        copy(sender)
        deleteBackward(sender)
    }

    @objc open func delete(_ sender: AnyObject) {
        deleteBackward(sender)
    }
}
