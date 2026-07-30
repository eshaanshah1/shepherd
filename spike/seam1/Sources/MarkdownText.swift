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
    /// Wrap code blocks instead of scrolling them. A `ScrollView` swallows the scroll
    /// wheel, which is fatal for a card hosted over the editor — the wheel has to reach
    /// the document underneath.
    var wrapsCode = false
    var blockSpacing: CGFloat = 6

    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(source, baseSize: font) }

    var body: some View {
        VStack(alignment: .leading, spacing: blockSpacing) {
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
            codeBlock(text)

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

    @ViewBuilder private func codeBlock(_ text: String) -> some View {
        let code = Text(text).font(.mono(font - 0.5))
            .foregroundStyle(Color(hex: Theme.Code.text))
            .textSelection(.enabled)
        Group {
            if wrapsCode {
                code.fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(7)
            } else {
                // Scrolls rather than wraps — wrapped code is worse than clipped code,
                // anywhere the scroll wheel isn't needed for something else.
                ScrollView(.horizontal, showsIndicators: false) { code.padding(7) }
            }
        }
        .background(Color(hex: Theme.Diff.buffer))
        .clipShape(RoundedRectangle(cornerRadius: 5))
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
    ///
    /// Memoized: an inline note card is hosted over the editor and re-renders on every
    /// SwiftUI pass, including one per scroll tick, so parsing per `body` evaluation is
    /// the same per-scroll waste the gutter's walk is bounded to avoid.
    static func parse(_ source: String, baseSize: CGFloat = 12) -> [MarkdownBlock] {
        let key = Key(source: source, baseSize: baseSize)
        if let hit = cache[key] { return hit }
        var blocks: [MarkdownBlock] = []
        append(children: Markdown.Document(parsing: source), to: &blocks, depth: 0,
               baseSize: baseSize)
        // A flat cap rather than an LRU: the working set is the notes on one PR, and the
        // only cost of evicting the lot is re-parsing them once.
        if cache.count > 512 { cache.removeAll() }
        cache[key] = blocks
        return blocks
    }

    private struct Key: Hashable {
        let source: String
        let baseSize: CGFloat
    }

    private static var cache: [Key: [MarkdownBlock]] = [:]

    private static func append(children parent: Markup, to blocks: inout [MarkdownBlock],
                               depth: Int, baseSize: CGFloat) {
        for child in parent.children {
            switch child {
            case let node as Markdown.Paragraph:
                blocks.append(.paragraph(inline(node, baseSize: baseSize)))
            case let node as Markdown.Heading:
                blocks.append(.heading(level: node.level, inline(node, baseSize: baseSize)))
            case let node as Markdown.CodeBlock:
                blocks.append(.code(node.code.trimmingCharacters(in: .newlines)))
            case let node as Markdown.BlockQuote:
                blocks.append(.quote(AttributedString(node.format())))
            case is Markdown.ThematicBreak:
                blocks.append(.rule)
            case let node as Markdown.UnorderedList:
                for item in node.listItems {
                    appendListItem(item, marker: "•", to: &blocks, depth: depth,
                                   baseSize: baseSize)
                }
            case let node as Markdown.OrderedList:
                for (index, item) in node.listItems.enumerated() {
                    appendListItem(item, marker: "\(index + 1).", to: &blocks, depth: depth,
                                   baseSize: baseSize)
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
                                       to blocks: inout [MarkdownBlock], depth: Int,
                                       baseSize: CGFloat) {
        var isFirst = true
        for child in item.children {
            if let paragraph = child as? Paragraph, isFirst {
                blocks.append(.listItem(depth: depth, marker: marker,
                                        inline(paragraph, baseSize: baseSize)))
                isFirst = false
            } else {
                append(children: item, to: &blocks, depth: depth + 1, baseSize: baseSize)
                break
            }
        }
        if isFirst {   // an empty item still needs its bullet
            blocks.append(.listItem(depth: depth, marker: marker, AttributedString("")))
        }
    }

    /// Resolve inline markup: emphasis, strong, inline code, links.
    private static func inline(_ markup: Markup, baseSize: CGFloat) -> AttributedString {
        var out = AttributedString()
        appendInline(markup, into: &out, bold: false, italic: false, link: nil,
                     baseSize: baseSize)
        return out
    }

    private static func appendInline(_ markup: Markup, into out: inout AttributedString,
                                     bold: Bool, italic: Bool, link: String?,
                                     baseSize: CGFloat) {
        for child in markup.children {
            switch child {
            case let node as Markdown.Text:
                out += styled(node.string, bold: bold, italic: italic, link: link,
                              baseSize: baseSize)
            case let node as Markdown.InlineCode:
                var run = AttributedString(node.code)
                run.font = .mono(baseSize - 0.5)
                run.foregroundColor = Color(hex: Theme.Code.string)
                out += run
            case is Markdown.SoftBreak:
                out += AttributedString(" ")
            case is Markdown.LineBreak:
                out += AttributedString("\n")
            case let node as Markdown.Strong:
                appendInline(node, into: &out, bold: true, italic: italic, link: link,
                             baseSize: baseSize)
            case let node as Markdown.Emphasis:
                appendInline(node, into: &out, bold: bold, italic: true, link: link,
                             baseSize: baseSize)
            case let node as Markdown.Link:
                appendInline(node, into: &out, bold: bold, italic: italic,
                             link: node.destination, baseSize: baseSize)
            default:
                appendInline(child, into: &out, bold: bold, italic: italic, link: link,
                             baseSize: baseSize)
            }
        }
    }

    private static func styled(_ string: String, bold: Bool, italic: Bool,
                               link: String?, baseSize: CGFloat) -> AttributedString {
        var run = AttributedString(string)
        var font = Font.ui(baseSize, bold ? .semibold : .regular)
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
