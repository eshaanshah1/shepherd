import SwiftUI
import Markdown

/// Renders a markdown string — a PR review comment, an issue body — as native SwiftUI.
///
/// Separate from `MarkdownDiffView`, which renders *two* documents against each other and
/// whose whole structure is about change. This one just displays one document, which is
/// what a comment is.
///
/// Deliberately partial: paragraphs, headings, lists, code blocks, block quotes, rules,
/// and inline emphasis/code/links. That covers what people actually write in review
/// comments. Anything unhandled degrades to its plain text rather than vanishing.
struct MarkdownText: View {
    let source: String
    var font: CGFloat = 12

    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(source) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(text).font(.ui(font)).foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

        case .heading(let level, let text):
            Text(text)
                .font(.ui(font + (level <= 2 ? 3 : 1), .semibold))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

        case .listItem(let depth, let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).font(.ui(font)).foregroundStyle(Theme.textDim)
                Text(text).font(.ui(font)).foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(depth) * 12)

        case .code(let text):
            // Scrolls rather than wraps — wrapped code is worse than clipped code.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.mono(font - 0.5)).foregroundStyle(Color(hex: Theme.Code.text))
                    .textSelection(.enabled)
                    .padding(7)
            }
            .background(Color(hex: Theme.Diff.buffer))
            .clipShape(RoundedRectangle(cornerRadius: 5))

        case .quote(let text):
            HStack(alignment: .top, spacing: 7) {
                RoundedRectangle(cornerRadius: 1).fill(Theme.textDim.opacity(0.5)).frame(width: 2)
                Text(text).font(.ui(font)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        case .rule:
            Rectangle().fill(Theme.divider).frame(height: 1)
        }
    }
}

/// One rendered block of a markdown document, with its inline markup already resolved to
/// an `AttributedString`.
enum MarkdownBlock {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case listItem(depth: Int, marker: String, AttributedString)
    case code(String)
    case quote(AttributedString)
    case rule

    /// Flatten a document to a renderable block list. Nested lists keep their depth;
    /// everything else that isn't handled contributes its plain text as a paragraph, so
    /// no content is ever silently dropped.
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        append(children: Markdown.Document(parsing: source), to: &blocks, depth: 0)
        return blocks
    }

    private static func append(children parent: Markup, to blocks: inout [MarkdownBlock],
                               depth: Int) {
        for child in parent.children {
            switch child {
            case let node as Markdown.Paragraph:
                blocks.append(.paragraph(inline(node)))
            case let node as Markdown.Heading:
                blocks.append(.heading(level: node.level, inline(node)))
            case let node as Markdown.CodeBlock:
                blocks.append(.code(node.code.trimmingCharacters(in: .newlines)))
            case let node as Markdown.BlockQuote:
                blocks.append(.quote(AttributedString(node.format())))
            case is Markdown.ThematicBreak:
                blocks.append(.rule)
            case let node as Markdown.UnorderedList:
                for item in node.listItems {
                    appendListItem(item, marker: "•", to: &blocks, depth: depth)
                }
            case let node as Markdown.OrderedList:
                for (index, item) in node.listItems.enumerated() {
                    appendListItem(item, marker: "\(index + 1).", to: &blocks, depth: depth)
                }
            default:
                let text = child.format().trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { blocks.append(.paragraph(AttributedString(text))) }
            }
        }
    }

    /// A list item's own paragraph becomes the bullet line; anything nested under it
    /// (sub-lists, code blocks) recurses one level deeper.
    private static func appendListItem(_ item: Markdown.ListItem, marker: String,
                                       to blocks: inout [MarkdownBlock], depth: Int) {
        var isFirst = true
        for child in item.children {
            if let paragraph = child as? Paragraph, isFirst {
                blocks.append(.listItem(depth: depth, marker: marker, inline(paragraph)))
                isFirst = false
            } else {
                append(children: item, to: &blocks, depth: depth + 1)
                break
            }
        }
        if isFirst {   // an empty item still needs its bullet
            blocks.append(.listItem(depth: depth, marker: marker, AttributedString("")))
        }
    }

    /// Resolve inline markup: emphasis, strong, inline code, links.
    private static func inline(_ markup: Markup) -> AttributedString {
        var out = AttributedString()
        appendInline(markup, into: &out, bold: false, italic: false, link: nil)
        return out
    }

    private static func appendInline(_ markup: Markup, into out: inout AttributedString,
                                     bold: Bool, italic: Bool, link: String?) {
        for child in markup.children {
            switch child {
            case let node as Markdown.Text:
                out += styled(node.string, bold: bold, italic: italic, link: link)
            case let node as Markdown.InlineCode:
                var run = AttributedString(node.code)
                run.font = .mono(11.5)
                run.foregroundColor = Color(hex: Theme.Code.string)
                out += run
            case is Markdown.SoftBreak:
                out += AttributedString(" ")
            case is Markdown.LineBreak:
                out += AttributedString("\n")
            case let node as Markdown.Strong:
                appendInline(node, into: &out, bold: true, italic: italic, link: link)
            case let node as Markdown.Emphasis:
                appendInline(node, into: &out, bold: bold, italic: true, link: link)
            case let node as Markdown.Link:
                appendInline(node, into: &out, bold: bold, italic: italic,
                             link: node.destination)
            default:
                appendInline(child, into: &out, bold: bold, italic: italic, link: link)
            }
        }
    }

    private static func styled(_ string: String, bold: Bool, italic: Bool,
                               link: String?) -> AttributedString {
        var run = AttributedString(string)
        var font = Font.ui(12, bold ? .semibold : .regular)
        if italic { font = font.italic() }
        run.font = font
        if let link, let url = URL(string: link) {
            run.link = url
            run.foregroundColor = Theme.prMerged
            run.underlineStyle = .single
        }
        return run
    }
}
