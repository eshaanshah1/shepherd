//
//  LineFragment.swift
//  CodeEditTextView
//
//  Created by Khan Winter on 6/29/23.
//

import AppKit

/// A ``LineFragment`` represents a subrange of characters in a line. Every text line contains at least one line
/// fragments, and any lines that need to be broken due to width constraints will contain more than one fragment.
public final class LineFragment: Identifiable, Equatable {
    public struct FragmentContent: Equatable {
        public enum Content: Equatable {
            case text(line: CTLine)
            case attachment(attachment: AnyTextAttachment)
        }

        public let data: Content
        public let width: CGFloat

        public var length: Int {
            switch data {
            case .text(let line):
                CTLineGetStringRange(line).length
            case .attachment(let attachment):
                attachment.range.length
            }
        }

#if DEBUG
        var isText: Bool {
            switch data {
            case .text:
                true
            case .attachment:
                false
            }
        }
#endif
    }

    public struct ContentPosition {
        let xPos: CGFloat
        let offset: Int
    }

    public let id = UUID()
    public var documentRange: NSRange = .notFound
    public var contents: [FragmentContent]
    public var width: CGFloat
    public var height: CGFloat
    public var descent: CGFloat
    public var scaledHeight: CGFloat

    /// Space reserved above this fragment's text, for a decoration drawn in the row's
    /// own space (Shepherd: diff block rows — file headers, hunk gaps, deleted lines).
    ///
    /// **Shepherd addition to the vendored editor.** The fragment is grown to make room,
    /// so anything measuring the *text* — the caret, selection rects — has to discount
    /// the reserved space or it covers the decoration too.
    public var topInset: CGFloat = 0

    /// The fragment's height excluding any reserved decoration space.
    public var textHeight: CGFloat { scaledHeight - topInset }

    /// The difference between the real text height and the scaled height
    public var heightDifference: CGFloat {
        scaledHeight - height
    }

    init(
        contents: [FragmentContent],
        width: CGFloat,
        height: CGFloat,
        descent: CGFloat,
        lineHeightMultiplier: CGFloat
    ) {
        self.contents = contents
        self.width = width
        self.height = height
        self.descent = descent
        self.scaledHeight = height * lineHeightMultiplier
    }

    public static func == (lhs: LineFragment, rhs: LineFragment) -> Bool {
        lhs.id == rhs.id
    }

    /// Finds the x position of the offset in the string the fragment represents.
    ///
    /// Underscored, because although this needs to be accessible outside this class, the relevant layout manager method
    /// should be used.
    ///
    /// - Parameter offset: The offset, relative to the start of the *line*.
    /// - Returns: The x position of the character in the drawn line, from the left.
    func _xPos(for offset: Int) -> CGFloat {
        guard let (content, position) = findContent(at: offset) else {
            return width
        }
        switch content.data {
        case .text(let ctLine):
            return CTLineGetOffsetForStringIndex(
                ctLine,
                CTLineGetStringRange(ctLine).location + offset - position.offset,
                nil
            ) + position.xPos
        case .attachment:
            return position.xPos
        }
    }

    package func findContent(at location: Int) -> (content: FragmentContent, position: ContentPosition)? {
        var position = ContentPosition(xPos: 0, offset: 0)

        for content in contents {
            let length = content.length
            let width = content.width

            if (position.offset..<(position.offset + length)).contains(location) {
                return (content, position)
            }

            position = ContentPosition(xPos: position.xPos + width, offset: position.offset + length)
        }

        return nil
    }

    package func findContent(atX xPos: CGFloat) -> (content: FragmentContent, position: ContentPosition)? {
        var position = ContentPosition(xPos: 0, offset: 0)

        for content in contents {
            let length = content.length
            let width = content.width

            if (position.xPos..<(position.xPos + width)).contains(xPos) {
                return (content, position)
            }

            position = ContentPosition(xPos: position.xPos + width, offset: position.offset + length)
        }

        return nil
    }
}
