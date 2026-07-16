import SwiftUI
import Markdown

/// Native rendered-markdown diff ([ADR 0019]). Parses both sides with apple/swift-markdown,
/// aligns top-level blocks, and renders the new document formatted — with inline
/// **word-level** highlighting inside changed prose (added words green, removed struck
/// red, surrounding markdown formatting intact), **cell-level** highlighting inside
/// changed tables, and a native key/value **frontmatter** block. We own the render path
/// here precisely so arbitrary changed spans can be tinted, which a black-box markdown
/// renderer can't do.
struct MarkdownDiffSource: Equatable { let old: String; let new: String }

struct MarkdownDiffView: View {
    private let groups: [[BlockRender]]

    init(source: MarkdownDiffSource) {
        let blocks = MarkdownDiffBuilder.build(old: source.old, new: source.new)
        self.groups = MarkdownDiffBuilder.group(MarkdownDiffBuilder.window(blocks))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(groups.indices, id: \.self) { i in
                MarkdownGroupView(group: groups[i])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

// MARK: - Diff model

/// One rendered block and how it changed. `Markup` nodes come straight from the parsed
/// documents; the view renders them.
enum BlockRender {
    case frontmatter(old: [MarkdownFrontmatter.Field], new: [MarkdownFrontmatter.Field])
    case plain(Markup)
    case added(Markup)
    case removed(Markup)
    case changedProse(old: Markup, new: Markup)
    case changedTable(old: Markdown.Table, new: Markdown.Table)
    case changedList(old: Markup, new: Markup, ordered: Bool)
    case collapsed(Int)   // N consecutive unchanged blocks hidden by context-windowing
}

enum MarkdownDiffBuilder {
    static func build(old: String, new: String) -> [BlockRender] {
        let (oldFM, oldBody) = MarkdownFrontmatter.split(old)
        let (newFM, newBody) = MarkdownFrontmatter.split(new)

        var out: [BlockRender] = []
        if oldFM != nil || newFM != nil {
            out.append(.frontmatter(old: oldFM ?? [], new: newFM ?? []))
        }

        let oldBlocks = Array(Document(parsing: oldBody).children)
        let newBlocks = Array(Document(parsing: newBody).children)
        let ops = SequenceAlign.lcs(oldBlocks.map { $0.format() }, newBlocks.map { $0.format() })

        var i = 0
        while i < ops.count {
            if case .keep(_, let n) = ops[i] { out.append(.plain(newBlocks[n])); i += 1; continue }
            var rem: [Int] = [], add: [Int] = []
            while i < ops.count, case .remove(let o) = ops[i] { rem.append(o); i += 1 }
            while i < ops.count, case .add(let n) = ops[i] { add.append(n); i += 1 }
            let paired = min(rem.count, add.count)
            for p in 0..<paired {
                out.append(contentsOf: pair(oldBlocks[rem[p]], newBlocks[add[p]]))
            }
            for p in paired..<rem.count { out.append(.removed(oldBlocks[rem[p]])) }
            for p in paired..<add.count { out.append(.added(newBlocks[add[p]])) }
        }
        return out
    }

    /// A replaced block becomes an in-place change when both sides are the same diffable
    /// kind (paragraph/heading → word diff, table → cell diff, list → item diff);
    /// otherwise it stays a remove + add pair (rendered old-red / new-green).
    private static func pair(_ old: Markup, _ new: Markup) -> [BlockRender] {
        if let ot = old as? Markdown.Table, let nt = new as? Markdown.Table { return [.changedTable(old: ot, new: nt)] }
        if isList(old), isList(new), (old is OrderedList) == (new is OrderedList) {
            return [.changedList(old: old, new: new, ordered: old is OrderedList)]
        }
        if sameProseKind(old, new) { return [.changedProse(old: old, new: new)] }
        return [.removed(old), .added(new)]
    }

    private static func isList(_ m: Markup) -> Bool { m is UnorderedList || m is OrderedList }

    /// Context-windowing: keep changed blocks plus `context` neighbors on each side,
    /// collapsing runs of untouched blocks into a `.collapsed(N)` marker — so a small
    /// edit in a long doc doesn't render the whole file (mirrors a diff's context lines).
    static func window(_ blocks: [BlockRender], context: Int = 2) -> [BlockRender] {
        let interesting = blocks.indices.filter { groupKind(blocks[$0]) != .plain }
        guard !interesting.isEmpty, interesting.count < blocks.count else { return blocks }
        var keep = Set<Int>()
        for idx in interesting {
            for j in max(0, idx - context)...min(blocks.count - 1, idx + context) { keep.insert(j) }
        }
        var out: [BlockRender] = []
        var i = 0
        while i < blocks.count {
            if keep.contains(i) { out.append(blocks[i]); i += 1; continue }
            var count = 0
            while i < blocks.count, !keep.contains(i) { count += 1; i += 1 }
            out.append(.collapsed(count))
        }
        return out
    }

    /// True when both nodes are the same inline-bearing block we diff word-by-word.
    /// Only pure-inline blocks (paragraph, heading) — lists/quotes/code fall back to
    /// remove+add so we never thread a word cursor through nested block structure.
    private static func sameProseKind(_ a: Markup, _ b: Markup) -> Bool {
        switch (a, b) {
        case (is Paragraph, is Paragraph): return true
        case (let ha as Heading, let hb as Heading): return ha.level == hb.level
        default: return false
        }
    }

    /// How a block is tinted — the grouping key. Consecutive blocks of the same kind
    /// render under one gutter bar + tint (so a run of additions reads as one region,
    /// not a stack of separate bars). Frontmatter is always its own group (a card).
    enum GroupKind: Equatable { case frontmatter, plain, added, removed, changed, collapsed }

    static func groupKind(_ b: BlockRender) -> GroupKind {
        switch b {
        case .frontmatter: return .frontmatter
        case .plain: return .plain
        case .added: return .added
        case .removed: return .removed
        case .changedProse, .changedTable, .changedList: return .changed
        case .collapsed: return .collapsed
        }
    }

    static func group(_ blocks: [BlockRender]) -> [[BlockRender]] {
        // Only tinted/plain runs coalesce; frontmatter and collapsed markers stay solo.
        let mergeable: Set<GroupKind> = [.plain, .added, .removed, .changed]
        var groups: [[BlockRender]] = []
        for b in blocks {
            if let first = groups.last?.first,
               groupKind(first) == groupKind(b), mergeable.contains(groupKind(b)) {
                groups[groups.count - 1].append(b)
            } else {
                groups.append([b])
            }
        }
        return groups
    }
}

// MARK: - Palette

private enum MDPalette {
    static let text = Shepherd.Theme.textPrimary
    static let dim = Shepherd.Theme.textSecondary
    static let faint = Shepherd.Theme.textDim
    static let added = Shepherd.Theme.needsCheck
    static let removed = Shepherd.Theme.error
    static let changed = Shepherd.Theme.working
    static let code = Shepherd.Theme.pick(dark: 0x8AA9C7, light: 0x4A6B8A, warm: 0x4A7996)   // subtle steel blue — off green (adds) and off the vivid changed-blue
    static let link = Shepherd.Theme.accent
    static let hairline = Shepherd.Theme.hairline
    // Diff tints: `line` = whole-line wash, `dense` = the changed span within it.
    static let addLine = added.opacity(0.20)
    static let remLine = removed.opacity(0.20)
    static let addDense = added.opacity(0.50)
    static let remDense = removed.opacity(0.44)
}

// MARK: - Inline styling

private struct InlineStyle {
    var bold = false, italic = false, mono = false, link = false
    var size: CGFloat = 13

    func bolded() -> InlineStyle { var s = self; s.bold = true; return s }
    func italicized() -> InlineStyle { var s = self; s.italic = true; return s }
    func monospaced() -> InlineStyle { var s = self; s.mono = true; return s }
    func linked() -> InlineStyle { var s = self; s.link = true; return s }

    func font() -> Font {
        var f: Font = mono ? .mono(size - 1) : .ui(size, bold ? .semibold : .regular)
        if italic { f = f.italic() }
        return f
    }
    var color: Color { link ? MDPalette.link : (mono ? MDPalette.code : MDPalette.text) }
}

private enum WordState { case keep, add, remove }

private func run(_ s: String, _ style: InlineStyle, _ state: WordState) -> AttributedString {
    var a = AttributedString(s)
    a.font = style.font()
    switch state {
    case .keep:
        a.foregroundColor = style.color
    case .add:
        // Background is the diff signal; foreground kept as a fallback since SwiftUI
        // Text only renders AttributedString backgroundColor on newer macOS.
        a.foregroundColor = MDPalette.added
        a.backgroundColor = MDPalette.added.opacity(0.32)
    case .remove:
        a.foregroundColor = MDPalette.removed
        a.backgroundColor = MDPalette.removed.opacity(0.28)
        a.strikethroughStyle = SwiftUI.Text.LineStyle(pattern: .solid, color: MDPalette.removed)
    }
    return a
}

private func space(_ out: inout AttributedString) {
    if let last = out.characters.last, last != " ", last != "\n" { out += AttributedString(" ") }
}

/// Walks inline markup building an AttributedString. With a cursor, each word is colored
/// by the word-diff (added green, removed struck red) while keeping bold/italic/code/link
/// styling; without one, text is emitted verbatim (unchanged blocks).
private func appendInline(_ markup: Markup, into out: inout AttributedString, style: InlineStyle, cursor: WordCursor?) {
    for child in markup.children {
        switch child {
        case let t as Markdown.Text: appendText(t.string, &out, style, cursor)
        case let c as InlineCode:     appendText(c.code, &out, style.monospaced(), cursor)
        case let e as Emphasis:       appendInline(e, into: &out, style: style.italicized(), cursor: cursor)
        case let s as Strong:         appendInline(s, into: &out, style: style.bolded(), cursor: cursor)
        case let s as Strikethrough:  appendInline(s, into: &out, style: style, cursor: cursor)
        case let l as Markdown.Link:  appendInline(l, into: &out, style: style.linked(), cursor: cursor)
        case is SoftBreak:            if cursor == nil { out += AttributedString(" ") }
        case is LineBreak:            out += AttributedString("\n")
        case let img as Markdown.Image:
            let alt = img.plainText.isEmpty ? (img.source ?? "image") : img.plainText
            appendText("🖼 " + alt, &out, style, cursor)
        default:
            appendInline(child, into: &out, style: style, cursor: cursor)
        }
    }
}

private func appendText(_ s: String, _ out: inout AttributedString, _ style: InlineStyle, _ cursor: WordCursor?) {
    guard let cursor else { out += run(s, style, .keep); return }
    for word in MarkdownInlineDiff.tokenize(s) {
        let (removed, added) = cursor.advance()
        for r in removed { space(&out); out += run(r, style, .remove) }
        space(&out); out += run(word, style, added ? .add : .keep)
    }
}

private func inlineAttr(_ m: Markup, base: InlineStyle, cursor: WordCursor?) -> AttributedString {
    var out = AttributedString()
    appendInline(m, into: &out, style: base, cursor: cursor)
    if let cursor { for r in cursor.trailingRemoved() { space(&out); out += run(r, base, .remove) } }
    return out
}

/// The word sequence of a block, tokenized exactly as `appendInline` emits it so a
/// cursor built from two of these stays aligned with the render walk.
private func plainWords(_ m: Markup) -> [String] {
    var words: [String] = []
    func walk(_ n: Markup) {
        for child in n.children {
            switch child {
            case let t as Markdown.Text: words += MarkdownInlineDiff.tokenize(t.string)
            case let c as InlineCode:    words += MarkdownInlineDiff.tokenize(c.code)
            case let img as Markdown.Image:
                let alt = img.plainText.isEmpty ? (img.source ?? "image") : img.plainText
                words += MarkdownInlineDiff.tokenize("🖼 " + alt)
            case is SoftBreak, is LineBreak: break
            default: walk(child)
            }
        }
    }
    walk(m)
    return words
}

/// Walks inline markup, invoking `emit` for each text-bearing run with its accumulated
/// style — the formatting-preserving basis for the before/after line renderers.
private func walkInline(_ markup: Markup, style: InlineStyle, emit: (String, InlineStyle) -> Void) {
    for child in markup.children {
        switch child {
        case let t as Markdown.Text: emit(t.string, style)
        case let c as InlineCode:    emit(c.code, style.monospaced())
        case let e as Emphasis:      walkInline(e, style: style.italicized(), emit: emit)
        case let s as Strong:        walkInline(s, style: style.bolded(), emit: emit)
        case let s as Strikethrough: walkInline(s, style: style, emit: emit)
        case let l as Markdown.Link: walkInline(l, style: style.linked(), emit: emit)
        case is SoftBreak, is LineBreak: break
        case let img as Markdown.Image:
            emit("🖼 " + (img.plainText.isEmpty ? (img.source ?? "image") : img.plainText), style)
        default: walkInline(child, style: style, emit: emit)
        }
    }
}

/// The diff lines for a changed span, per the design rule: a **pure** addition or
/// deletion stays on **one** line with the changed words densely highlighted; a **mixed**
/// edit renders **two** lines (whole-old red, whole-new green) with no intra-line marks.
/// `renderOld`/`renderNew` build a line from the caller's own content (markup or text)
/// given the per-word dense flags (and, for old, whether to strike).
private func changeLines(oldWords: [String], newWords: [String],
                         old renderOld: ([Bool], Bool) -> AttributedString,
                         new renderNew: ([Bool]) -> AttributedString) -> [(AttributedString, Color)] {
    let ops = MarkdownInlineDiff.diffWords(old: oldWords, new: newWords)
    let hasAdd = ops.contains { if case .add = $0 { return true }; return false }
    let hasRemove = ops.contains { if case .remove = $0 { return true }; return false }
    func flags(add: Bool) -> [Bool] {
        ops.compactMap { op in
            switch op {
            case .keep: return false
            case .add: return add ? true : nil
            case .remove: return add ? nil : true
            }
        }
    }
    if hasAdd && !hasRemove {
        return [(renderNew(flags(add: true)), MDPalette.addLine)]
    } else if hasRemove && !hasAdd {
        return [(renderOld(flags(add: false), true), MDPalette.remLine)]
    } else {
        return [(renderOld(Array(repeating: false, count: oldWords.count), false), MDPalette.remLine),
                (renderNew(Array(repeating: false, count: newWords.count)), MDPalette.addLine)]
    }
}

/// One diff line from inline markup: formatting preserved; words flagged dense get a
/// darker background (and bold), the rest sit on the row's light tint.
private func lineFromMarkup(_ m: Markup, dense: [Bool], denseBG: Color, base: InlineStyle, strike: Bool) -> AttributedString {
    var out = AttributedString(); var i = 0
    walkInline(m, style: base) { s, style in
        for w in MarkdownInlineDiff.tokenize(s) {
            space(&out)
            let d = i < dense.count && dense[i]
            out += denseWord(w, style: style, dense: d, denseBG: denseBG, strike: strike)
            i += 1
        }
    }
    return out
}

/// One diff line from a plain string (frontmatter values, which carry no markup).
private func lineFromText(_ words: [String], dense: [Bool], denseBG: Color, base: InlineStyle, strike: Bool) -> AttributedString {
    var out = AttributedString()
    for (i, w) in words.enumerated() {
        space(&out)
        out += denseWord(w, style: base, dense: i < dense.count && dense[i], denseBG: denseBG, strike: strike)
    }
    return out
}

private func denseWord(_ w: String, style: InlineStyle, dense: Bool, denseBG: Color, strike: Bool) -> AttributedString {
    var a = AttributedString(w)
    a.font = dense ? style.bolded().font() : style.font()
    a.foregroundColor = style.color
    if dense {
        a.backgroundColor = denseBG
        if strike { a.strikethroughStyle = SwiftUI.Text.LineStyle(pattern: .solid, color: MDPalette.removed) }
    }
    return a
}

private final class WordCursor {
    private let ops: [WordOp]
    private var i = 0
    init(_ ops: [WordOp]) { self.ops = ops }

    /// Removed words preceding the next new-side word, and whether that word was added.
    func advance() -> (removed: [String], added: Bool) {
        var removed: [String] = []
        while i < ops.count, case .remove(let w) = ops[i] { removed.append(w); i += 1 }
        var added = false
        if i < ops.count { if case .add = ops[i] { added = true }; i += 1 }
        return (removed, added)
    }
    func trailingRemoved() -> [String] {
        var r: [String] = []
        while i < ops.count, case .remove(let w) = ops[i] { r.append(w); i += 1 }
        return r
    }
}

// MARK: - Block views

/// A run of consecutive same-kind blocks, rendered under one gutter bar + tint so a
/// stretch of additions/removals reads as a single region, not a stack of bars.
private struct MarkdownGroupView: View {
    let group: [BlockRender]

    var body: some View {
        switch MarkdownDiffBuilder.groupKind(group[0]) {
        case .frontmatter, .collapsed:
            blockCore(group[0])
        case .plain:
            stack
        case .added:
            stack.diffTint(bar: MDPalette.added, bg: MDPalette.added.opacity(0.08))
        case .removed:
            stack.diffTint(bar: MDPalette.removed, bg: MDPalette.removed.opacity(0.08)).opacity(0.72)
        case .changed:
            stack.diffTint(bar: MDPalette.changed, bg: .clear)
        }
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(group.indices, id: \.self) { i in blockCore(group[i]) }
        }
    }
}

/// Render one block's content without any tint (the group applies the bar/background).
private func blockCore(_ b: BlockRender) -> AnyView {
    switch b {
    case let .plain(m), let .added(m), let .removed(m):
        return blockContent(m, cursor: nil)
    case let .changedProse(old, new):
        return AnyView(ChangedProseView(old: old, new: new))
    case let .changedTable(old, new):
        return AnyView(TableDiffCard(old: old, new: new))
    case let .changedList(old, new, ordered):
        return AnyView(ListDiffView(old: old, new: new, ordered: ordered))
    case let .frontmatter(old, new):
        return AnyView(FrontmatterCard(old: old, new: new))
    case let .collapsed(n):
        return AnyView(CollapsedMarker(count: n))
    }
}

/// A changed paragraph/heading rendered GitHub-style: a before line (light red) over an
/// after line (light green), with a denser highlight on the changed words only when the
/// edit is a pure add or pure remove.
private struct ChangedProseView: View {
    let old: Markup
    let new: Markup

    var body: some View {
        let base = (new as? Heading).map { headingStyle($0.level) } ?? InlineStyle()
        let lines = changeLines(
            oldWords: plainWords(old), newWords: plainWords(new),
            old: { f, st in lineFromMarkup(old, dense: f, denseBG: MDPalette.remDense, base: base, strike: st) },
            new: { f in lineFromMarkup(new, dense: f, denseBG: MDPalette.addDense, base: base, strike: false) })
        return DiffLines(lines: lines)
    }
}

/// Stacks the one or two lines produced by `changeLines`, each on its whole-line tint.
private struct DiffLines: View {
    let lines: [(AttributedString, Color)]
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(lines.indices, id: \.self) { i in
                SwiftUI.Text(lines[i].0)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 3).padding(.horizontal, 8)
                    .background(lines[i].1)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            }
        }
    }
}

/// A hard, unmistakable break for the hidden unchanged region — a filled pill so it
/// never reads as continuous prose.
private struct CollapsedMarker: View {
    let count: Int
    var body: some View {
        HStack(spacing: 8) {
            line
            HStack(spacing: 5) {
                Image(systemName: "arrow.down.and.line.horizontal.and.arrow.up").font(.system(size: 8, weight: .bold))
                SwiftUI.Text("\(count) unchanged section\(count == 1 ? "" : "s")").font(.ui(10, .semibold))
            }
            .foregroundStyle(MDPalette.dim)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(Shepherd.Theme.surface2)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(MDPalette.hairline, lineWidth: 1))
            .fixedSize()
            line
        }
        .padding(.vertical, 6)
    }
    private var line: some View { Rectangle().fill(MDPalette.hairline).frame(height: 1) }
}

private func listItems(_ m: Markup) -> [ListItem] {
    Array(m.children.compactMap { $0 as? ListItem })
}

/// Item-level list diff: align the two lists' items and render one list, highlighting
/// only changed items (word diff), added items (green), and removed items (struck red) —
/// instead of showing the whole old list red and whole new list green.
private struct ListDiffView: View {
    let old: Markup
    let new: Markup
    let ordered: Bool

    private struct Row: Identifiable { let id = UUID(); let marker: String; let lines: [(AttributedString, Color)] }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows()) { row in
                HStack(alignment: .top, spacing: 8) {
                    SwiftUI.Text(row.marker).font(.ui(13)).foregroundStyle(MDPalette.dim)
                        .frame(minWidth: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(row.lines.indices, id: \.self) { i in
                            let tinted = row.lines[i].1 != .clear
                            SwiftUI.Text(row.lines[i].0)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, tinted ? 2 : 0).padding(.horizontal, tinted ? 6 : 0)
                                .background(row.lines[i].1)
                                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                        }
                    }
                }
            }
        }
    }

    private func rows() -> [Row] {
        let oldItems = listItems(old), newItems = listItems(new)
        let ops = SequenceAlign.lcs(oldItems.map { $0.format() }, newItems.map { $0.format() })
        var rows: [Row] = []
        var number = 0
        var i = 0
        func marker() -> String { ordered ? "\(number)." : "•" }
        func markupLines(_ oi: Markup?, _ ni: Markup?) -> [(AttributedString, Color)] {
            changeLines(
                oldWords: oi.map(plainWords) ?? [], newWords: ni.map(plainWords) ?? [],
                old: { f, st in oi.map { lineFromMarkup($0, dense: f, denseBG: MDPalette.remDense, base: InlineStyle(), strike: st) } ?? AttributedString() },
                new: { f in ni.map { lineFromMarkup($0, dense: f, denseBG: MDPalette.addDense, base: InlineStyle(), strike: false) } ?? AttributedString() })
        }
        while i < ops.count {
            if case .keep(_, let n) = ops[i] {
                number += 1
                rows.append(Row(marker: marker(), lines: [(inlineAttr(newItems[n], base: InlineStyle(), cursor: nil), .clear)]))
                i += 1
                continue
            }
            var rem: [Int] = [], add: [Int] = []
            while i < ops.count, case .remove(let o) = ops[i] { rem.append(o); i += 1 }
            while i < ops.count, case .add(let n) = ops[i] { add.append(n); i += 1 }
            let paired = min(rem.count, add.count)
            for p in 0..<paired {
                number += 1
                rows.append(Row(marker: marker(), lines: markupLines(oldItems[rem[p]], newItems[add[p]])))
            }
            for p in paired..<rem.count {
                rows.append(Row(marker: ordered ? "−" : "•", lines: markupLines(oldItems[rem[p]], nil)))
            }
            for p in paired..<add.count {
                number += 1
                rows.append(Row(marker: marker(), lines: markupLines(nil, newItems[add[p]])))
            }
        }
        return rows
    }
}

private extension View {
    func diffTint(bar: Color, bg: Color) -> some View {
        self
            .padding(.vertical, 3)
            .padding(.leading, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(bg)
            .overlay(alignment: .leading) { Rectangle().fill(bar).frame(width: 2) }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

/// Render one block node to SwiftUI. Returns `AnyView` because the recursive cases
/// (blockquote, lists) nest `blockContent` inside themselves — a `some View` opaque type
/// can't be defined in terms of itself. A cursor (changed prose only) drives inline
/// word highlighting.
private func blockContent(_ m: Markup, cursor: WordCursor?) -> AnyView {
    if let h = m as? Heading {
        return AnyView(SwiftUI.Text(inlineAttr(h, base: headingStyle(h.level), cursor: cursor))
            .padding(.top, h.level <= 2 ? 4 : 0))
    } else if let p = m as? Paragraph {
        return AnyView(SwiftUI.Text(inlineAttr(p, base: InlineStyle(), cursor: cursor))
            .fixedSize(horizontal: false, vertical: true))
    } else if let code = m as? CodeBlock {
        return AnyView(CodeBlockView(code: code.code))
    } else if let quote = m as? BlockQuote {
        let children = Array(quote.children)
        return AnyView(VStack(alignment: .leading, spacing: 6) {
            ForEach(children.indices, id: \.self) { idx in blockContent(children[idx], cursor: nil) }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) { Rectangle().fill(MDPalette.hairline).frame(width: 2) }
        .foregroundStyle(MDPalette.dim))
    } else if let list = m as? UnorderedList {
        return AnyView(ListView(items: Array(list.listItems), ordered: false))
    } else if let list = m as? OrderedList {
        return AnyView(ListView(items: Array(list.listItems), ordered: true))
    } else if let table = m as? Markdown.Table {
        return AnyView(TablePlainCard(table: table))
    } else if m is ThematicBreak {
        return AnyView(Rectangle().fill(MDPalette.hairline).frame(height: 1).padding(.vertical, 4))
    } else {
        return AnyView(SwiftUI.Text(inlineAttr(m, base: InlineStyle(), cursor: cursor)))
    }
}

private func headingStyle(_ level: Int) -> InlineStyle {
    var s = InlineStyle(); s.bold = true
    switch level { case 1: s.size = 22; case 2: s.size = 18; case 3: s.size = 15; default: s.size = 13 }
    return s
}

private struct CodeBlockView: View {
    let code: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            SwiftUI.Text(code.hasSuffix("\n") ? String(code.dropLast()) : code)
                .font(.mono(12)).foregroundStyle(MDPalette.text)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Shepherd.Theme.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct ListView: View {
    let items: [ListItem]
    let ordered: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items.indices, id: \.self) { i in
                HStack(alignment: .top, spacing: 8) {
                    SwiftUI.Text(marker(i, items[i]))
                        .font(.ui(13)).foregroundStyle(MDPalette.dim)
                        .frame(minWidth: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items[i].children).indices, id: \.self) { c in
                            blockContent(Array(items[i].children)[c], cursor: nil)
                        }
                    }
                }
            }
        }
    }
    private func marker(_ i: Int, _ item: ListItem) -> String {
        if let box = item.checkbox { return box == .checked ? "☑" : "☐" }
        return ordered ? "\(i + 1)." : "•"
    }
}

// MARK: - Tables

private func tableStringGrid(_ t: Markdown.Table) -> [[String]] {
    let head = Array(t.head.children.compactMap { $0 as? Markdown.Table.Cell }).map { $0.plainText }
    let rows = Array(t.body.children.compactMap { $0 as? Markdown.Table.Row }).map { row in
        Array(row.children.compactMap { $0 as? Markdown.Table.Cell }).map { $0.plainText }
    }
    return [head] + rows
}

private func tableCellGrid(_ t: Markdown.Table) -> [[Markdown.Table.Cell]] {
    let head = Array(t.head.children.compactMap { $0 as? Markdown.Table.Cell })
    let rows = Array(t.body.children.compactMap { $0 as? Markdown.Table.Row }).map { row in
        Array(row.children.compactMap { $0 as? Markdown.Table.Cell })
    }
    return [head] + rows
}

/// Grid layout shared by the plain and diffed table renderers. Each cell carries its
/// attributed text and a background tint.
/// Table laid out with HStack rows + equal flexible columns rather than SwiftUI `Grid`:
/// `Grid` mis-sizes columns when cells use `maxWidth: .infinity` (needed for wrapping)
/// and one cell is taller than its row-mates. HStack handles flexible widths reliably.
private struct TableGrid: View {
    struct Cell: Identifiable { let id = UUID(); let lines: [(AttributedString, Color)] }
    let rows: [[Cell]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows.indices, id: \.self) { r in
                HStack(alignment: .top, spacing: 0) {
                    ForEach(rows[r]) { cell in
                        cellView(cell)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay(alignment: .trailing) { Rectangle().fill(MDPalette.hairline).frame(width: 1) }
                    }
                }
                .overlay(alignment: .bottom) { Rectangle().fill(MDPalette.hairline).frame(height: 1) }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(MDPalette.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func cellView(_ cell: Cell) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(cell.lines.indices, id: \.self) { i in
                let tinted = cell.lines[i].1 != .clear
                SwiftUI.Text(cell.lines[i].0)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, tinted ? 2 : 0).padding(.horizontal, tinted ? 4 : 0)
                    .background(cell.lines[i].1)
                    .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
    }
}

private struct TablePlainCard: View {
    let table: Markdown.Table
    var body: some View {
        let cells = tableCellGrid(table)
        TableGrid(rows: cells.indices.map { r in
            cells[r].map { cell in
                TableGrid.Cell(lines: [(inlineAttr(cell, base: cellStyle(header: r == 0), cursor: nil), .clear)])
            }
        })
    }
}

private struct TableDiffCard: View {
    let old: Markdown.Table
    let new: Markdown.Table
    var body: some View {
        let oldGrid = tableStringGrid(old)
        let newGrid = tableStringGrid(new)
        let newCells = tableCellGrid(new)
        let diff = MarkdownTableDiff.diff(old: oldGrid, new: newGrid)

        var rows: [[TableGrid.Cell]] = newCells.indices.map { r in
            newCells[r].indices.map { c in
                let header = r == 0
                if let oldText = diff.changed[MarkdownTableDiff.Cell(row: r, col: c)] {
                    // Same rule as prose: pure add/remove → one dense line, mixed → two.
                    let ow = MarkdownInlineDiff.tokenize(oldText), nw = MarkdownInlineDiff.tokenize(newGrid[r][c])
                    let lines = changeLines(oldWords: ow, newWords: nw,
                        old: { f, st in lineFromText(ow, dense: f, denseBG: MDPalette.remDense, base: cellStyle(header: header), strike: st) },
                        new: { f in lineFromText(nw, dense: f, denseBG: MDPalette.addDense, base: cellStyle(header: header), strike: false) })
                    return TableGrid.Cell(lines: lines)
                }
                let added = diff.addedRows.contains(r)
                return TableGrid.Cell(lines: [(inlineAttr(newCells[r][c], base: cellStyle(header: header), cursor: nil),
                                               added ? MDPalette.addLine : .clear)])
            }
        }
        // Rows only in the old table, shown struck-red after the new rows.
        for r in diff.removedRows where r < oldGrid.count {
            rows.append(oldGrid[r].map { txt in
                let w = MarkdownInlineDiff.tokenize(txt)
                let line = lineFromText(w, dense: Array(repeating: true, count: w.count),
                                        denseBG: MDPalette.remDense, base: cellStyle(header: false), strike: true)
                return TableGrid.Cell(lines: [(line, MDPalette.remLine)])
            })
        }
        return TableGrid(rows: rows)
    }
}

private func cellStyle(header: Bool) -> InlineStyle {
    var s = InlineStyle(); s.bold = header; s.size = 12; return s
}

// MARK: - Frontmatter metadata card

private struct FrontmatterCard: View {
    let old: [MarkdownFrontmatter.Field]
    let new: [MarkdownFrontmatter.Field]

    var body: some View {
        let oldByKey = Dictionary(old.map { ($0.key, $0.value) }, uniquingKeysWith: { a, _ in a })
        let newKeys = Set(new.map(\.key))
        let removed = old.filter { !newKeys.contains($0.key) }

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "list.bullet.rectangle").font(.system(size: 9))
                SwiftUI.Text("METADATA").font(.ui(9, .semibold)).tracking(0.8)
            }
            .foregroundStyle(MDPalette.faint)
            .padding(.bottom, 7)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(new.indices, id: \.self) { i in
                    fieldView(new[i], oldValue: oldByKey[new[i].key], oldEmpty: old.isEmpty)
                }
                ForEach(removed, id: \.key) { f in
                    metaRow(f.key) {
                        SwiftUI.Text(run(f.value.isEmpty ? "—" : f.value, InlineStyle(), .remove))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Shepherd.Theme.surface1)
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(MDPalette.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func metaRow<V: View>(_ key: String, @ViewBuilder _ value: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            SwiftUI.Text(key).font(.mono(11)).foregroundStyle(MDPalette.dim)
                .frame(width: 150, alignment: .leading)
            value()
        }
    }

    /// A value that changed renders as before/after two lines; everything else is a
    /// single line (empty → dim dash, new file → plain, new field → green, else plain).
    @ViewBuilder
    private func fieldView(_ field: MarkdownFrontmatter.Field, oldValue: String?, oldEmpty: Bool) -> some View {
        if field.value.isEmpty {
            metaRow(field.key) { valueText("—", .keep, dim: true) }
        } else if oldEmpty || oldValue == nil {
            metaRow(field.key) { valueText(field.value, oldEmpty ? .keep : .add) }
        } else if oldValue == field.value {
            metaRow(field.key) { valueText(field.value, .keep) }
        } else {
            let ow = MarkdownInlineDiff.tokenize(oldValue ?? "")
            let nw = MarkdownInlineDiff.tokenize(field.value)
            let lines = changeLines(
                oldWords: ow, newWords: nw,
                old: { f, st in lineFromText(ow, dense: f, denseBG: MDPalette.remDense, base: InlineStyle(), strike: st) },
                new: { f in lineFromText(nw, dense: f, denseBG: MDPalette.addDense, base: InlineStyle(), strike: false) })
            metaRow(field.key) { DiffLines(lines: lines) }
        }
    }

    private func valueText(_ s: String, _ state: WordState, dim: Bool = false) -> some View {
        var attr = run(s, InlineStyle(), state)
        if dim { attr.foregroundColor = MDPalette.faint; attr.backgroundColor = nil }
        return SwiftUI.Text(attr).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
