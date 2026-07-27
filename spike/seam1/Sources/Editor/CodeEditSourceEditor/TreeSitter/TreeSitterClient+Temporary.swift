//
//  TreeSitterClient+Temporary.swift
//  CodeEditSourceEditor
//
//  Created by Khan Winter on 7/24/25.
//

import AppKit
import SwiftTreeSitter
import CodeEditLanguages

extension TreeSitterClient {
    /// Parses a detached string and returns its highlight ranges, with no `TextView`
    /// involved.
    ///
    /// Extracted from ``quickHighlight(string:theme:font:language:)`` so the workbench's
    /// `MultiHighlighter` can highlight each source file of a stitched multibuffer
    /// independently. The capture-precedence filtering here is subtle (captures arrive
    /// reversed so lower indices can win), which is exactly why it should exist once.
    static func highlightRanges(string: String, language: CodeLanguage) -> [HighlightRange] {
        guard let parserLanguage = language.language,
              let query = TreeSitterModel.shared.query(for: language.id) else {
            return []
        }
        do {
            let parser = Parser()
            try parser.setLanguage(parserLanguage)
            guard let syntaxTree = parser.parse(string) else { return [] }
            let queryCursor = query.execute(in: syntaxTree)
            var ranges: [NSRange: Int] = [:]
            return queryCursor
                .resolve(with: .init(string: string))
                .flatMap { $0.captures }
                .reversed() // SwiftTreeSitter returns captures in the reverse order of what we need to filter with.
                .compactMap { capture in
                    let range = capture.range
                    let index = capture.index

                    // Lower indexed captures are favored over higher, this is why we reverse it above
                    if let existingLevel = ranges[range], existingLevel <= index {
                        return nil
                    }

                    guard let captureName = CaptureName.fromString(capture.name) else {
                        return nil
                    }

                    // Update the filter level to the current index since it's lower and a 'valid' capture
                    ranges[range] = index

                    return HighlightRange(range: range, capture: captureName)
                }
        } catch {
            return []
        }
    }

    static func quickHighlight(
        string: String,
        theme: EditorTheme,
        font: NSFont,
        language: CodeLanguage
    ) -> NSAttributedString? {
        guard language.language != nil, TreeSitterModel.shared.query(for: language.id) != nil else {
            return nil
        }

        let highlights = highlightRanges(string: string, language: language)
        let attributed = NSMutableAttributedString(string: string)

        for highlight in highlights {
            attributed.setAttributes(
                [
                    .font: theme.fontFor(for: highlight.capture, from: font),
                    .foregroundColor: theme.colorFor(highlight.capture)
                ],
                range: highlight.range
            )
        }

        return attributed
    }
}
