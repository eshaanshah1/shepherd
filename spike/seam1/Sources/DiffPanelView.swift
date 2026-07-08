import SwiftUI
import AppKit
import Highlighter

/// Panel state: current diff, mode, in-progress comments, and the background-staged
/// `pending` result for the GitHub-style "changes available" refresh.
@MainActor
final class DiffReviewModel: ObservableObject {
    @Published var mode: DiffMode = .workingTree
    @Published var files: [DiffFile] = []
    @Published var baseLabel: String? = nil
    @Published var isRepo = true
    @Published var loading = false
    @Published var comments: [ReviewComment] = []
    @Published var staleAvailable = false

    private var pending: DiffReadResult? = nil
    private(set) var cwd: String? = nil

    func load(cwd: String?, mode: DiffMode) {
        self.cwd = cwd
        self.mode = mode
        guard let cwd else { files = []; isRepo = false; return }
        loading = true
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async {
                self.files = result.files
                self.baseLabel = result.baseLabel
                self.isRepo = result.isRepo
                self.loading = false
                self.staleAvailable = false
                self.pending = nil
            }
        }
    }

    /// A turn ended while the panel is open: rebuild in the background, keep showing
    /// the current diff, and light the refresh banner.
    func onTurnEnded() {
        guard let cwd else { return }
        let m = mode
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DiffReader.read(cwd: cwd, mode: m)
            DispatchQueue.main.async { self.pending = result; self.staleAvailable = true }
        }
    }

    /// Swap the pre-built pending diff in (instant); or synchronously reload if none.
    func applyRefresh() {
        if let p = pending {
            files = p.files; baseLabel = p.baseLabel; isRepo = p.isRepo
            pending = nil; staleAvailable = false
        } else {
            load(cwd: cwd, mode: mode)
        }
    }

    func addComment(file: String, line: Int, side: DiffSide, text: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side, text: text))
    }
}

/// Whole-file syntax highlighting (HighlighterSwift / Highlight.js). Highlight each file
/// once, snap every token color to Shepherd's injected terminal palette so code reads
/// with the same hues as the grid, cache the per-line result, and map onto diff lines by
/// line number. Large / minified files skip highlighting and fall back to plain coloring.
enum DiffSyntaxHighlighter {
    private static let maxBytes = 500_000
    private static let highlighter: Highlighter? = {
        // atom-one-dark only serves as the tokenizer (distinct hue per token type);
        // the actual colors are remapped to Theme.syntaxPalette by `snap`.
        let h = Highlighter()
        _ = h?.setTheme("atom-one-dark")
        return h
    }()
    private static var cache: [String: [NSAttributedString]] = [:]

    /// Shepherd's terminal palette as sRGB components + the NSColor to apply.
    private static let palette: [(r: CGFloat, g: CGFloat, b: CGFloat, color: NSColor)] =
        Theme.syntaxPalette.map { hex in
            let r = CGFloat((hex >> 16) & 0xFF) / 255
            let g = CGFloat((hex >> 8) & 0xFF) / 255
            let b = CGFloat(hex & 0xFF) / 255
            return (r, g, b, NSColor(srgbRed: r, green: g, blue: b, alpha: 1))
        }

    /// Per-line highlighted attributed strings for a blob, or nil to fall back to plain.
    static func lines(forBlob blob: String, path: String, side: DiffSide) -> [NSAttributedString]? {
        guard blob.utf8.count <= maxBytes else { return nil }
        let key = "\(path)#\(side)#\(blob.hashValue)"
        if let hit = cache[key] { return hit }
        let lang = language(forPath: path)
        guard let raw = highlighter?.highlight(blob, as: lang) else { return nil }
        let attr = snap(raw)
        // Split the highlighted attributed string on newlines, preserving attributes.
        var result: [NSAttributedString] = []
        let plain = attr.string as NSString
        plain.enumerateSubstrings(in: NSRange(location: 0, length: plain.length),
                                  options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            result.append(attr.attributedSubstring(from: range))
        }
        cache[key] = result
        return result
    }

    /// Remap every foreground color to the nearest color in Shepherd's terminal
    /// palette and drop backgrounds, so highlighted code matches the injected theme.
    private static func snap(_ ns: NSAttributedString) -> NSAttributedString {
        let m = NSMutableAttributedString(attributedString: ns)
        let full = NSRange(location: 0, length: m.length)
        m.removeAttribute(.backgroundColor, range: full)
        m.enumerateAttribute(.foregroundColor, in: full) { value, range, _ in
            guard let col = (value as? NSColor)?.usingColorSpace(.sRGB) else { return }
            let r = col.redComponent, g = col.greenComponent, b = col.blueComponent
            var best = palette[0].color, bestD = CGFloat.greatestFiniteMagnitude
            for p in palette {
                let d = (p.r - r) * (p.r - r) + (p.g - g) * (p.g - g) + (p.b - b) * (p.b - b)
                if d < bestD { bestD = d; best = p.color }
            }
            m.addAttribute(.foregroundColor, value: best, range: range)
        }
        return m
    }

    /// Highlight.js language name from a file extension, or nil (auto-detect).
    private static func language(forPath path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "swift": return "swift"
        case "rb": return "ruby"
        case "kt", "kts": return "kotlin"
        case "ts", "tsx": return "typescript"
        case "js", "jsx": return "javascript"
        case "py": return "python"
        case "go": return "go"
        case "java": return "java"
        case "json": return "json"
        case "yml", "yaml": return "yaml"
        case "sh", "bash": return "bash"
        case "md": return "markdown"
        default: return nil
        }
    }
}

struct DiffPanelView: View {
    @EnvironmentObject var store: AgentStore
    @StateObject private var model = DiffReviewModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.staleAvailable { refreshBanner }
            Divider().overlay(Theme.hairline)
            content
        }
        .background(Theme.ground)
        .onAppear { reload() }
        .onChange(of: store.diffPanelPaneID) { _ in reload() }
        .onChange(of: model.mode) { _ in reload() }
        .onChange(of: store.diffTurnTick) { _ in
            if store.diffTurnPane == store.diffPanelPaneID { model.onTurnEnded() }
        }
    }

    private func reload() {
        guard let pid = store.diffPanelPaneID else { return }
        model.load(cwd: store.cwd(forPane: pid), mode: model.mode)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Review").font(.system(size: 12, weight: .semibold))
                .foregroundColor(Theme.textPrimary)
            Picker("", selection: $model.mode) {
                Text("Working tree").tag(DiffMode.workingTree)
                Text("vs \(model.baseLabel ?? "base")").tag(DiffMode.branchVsBase)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 180).focusable(false)
            Spacer()
            if !model.comments.isEmpty {
                Text("\(model.comments.count) comments").font(.system(size: 11))
                    .foregroundColor(Theme.textDim)
                Button("Send to agent") {
                    if let pid = store.diffPanelPaneID {
                        store.submitReview(model.comments, toPane: pid)
                        model.comments.removeAll()
                        store.diffPanelOpen = false
                    }
                }.focusable(false)
            }
            Button { model.applyRefresh() } label: { Image(systemName: "arrow.clockwise") }
                .focusable(false)
            Button { store.diffPanelOpen = false } label: { Image(systemName: "xmark") }
                .focusable(false)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var refreshBanner: some View {
        Button { model.applyRefresh() } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.clockwise")
                Text("Changes available — refresh")
            }
            .font(.system(size: 11)).frame(maxWidth: .infinity)
            .padding(.vertical, 5).background(Theme.working.opacity(0.18))
        }
        .buttonStyle(.plain).focusable(false)
    }

    @ViewBuilder private var content: some View {
        if !model.isRepo {
            centered("Not a git repository")
        } else if model.files.isEmpty {
            centered(model.loading ? "Loading…" : "No changes")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.files, id: \.path) { file in
                        DiffFileView(file: file, model: model,
                                     hasAgent: store.diffPanelPaneID.map { store.hasLiveAgent(paneID: $0) } ?? false,
                                     cwd: model.cwd, baseLabel: model.baseLabel)
                    }
                }
                .padding(12)
            }
        }
    }

    private func centered(_ s: String) -> some View {
        VStack { Spacer(); Text(s).foregroundColor(Theme.textDim).font(.system(size: 12)); Spacer() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct DiffFileView: View {
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool
    let cwd: String?
    let baseLabel: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(statusGlyph).font(.system(size: 11, weight: .bold)).foregroundColor(statusColor)
                Text(file.path).font(.system(size: 12, weight: .medium)).foregroundColor(Theme.textPrimary)
                Spacer()
                Text("+\(file.addedCount)").foregroundColor(Theme.needsCheck).font(.system(size: 11))
                Text("−\(file.removedCount)").foregroundColor(Theme.error).font(.system(size: 11))
            }
            .padding(.bottom, 4)
            if file.isBinary {
                Text("Binary file").foregroundColor(Theme.textDim).font(.system(size: 11))
            } else {
                ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        DiffLineRow(line: line, file: file, model: model, hasAgent: hasAgent,
                                    cwd: cwd, baseLabel: baseLabel)
                    }
                }
            }
        }
    }

    private var statusGlyph: String {
        switch file.status { case .added: return "A"; case .modified: return "M"
        case .deleted: return "D"; case .renamed: return "R" }
    }
    private var statusColor: Color {
        switch file.status { case .added: return Theme.needsCheck; case .deleted: return Theme.error
        default: return Theme.textDim }
    }
}

private struct DiffLineRow: View {
    let line: DiffLine
    let file: DiffFile
    @ObservedObject var model: DiffReviewModel
    let hasAgent: Bool
    let cwd: String?
    let baseLabel: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(gutter).frame(width: 44, alignment: .trailing)
                .foregroundColor(Theme.textDim).font(.system(size: 11, design: .monospaced))
            highlightedText
                .font(.system(size: 12, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(bg)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { if hasAgent { promptComment() } }
    }

    @ViewBuilder private var highlightedText: some View {
        if let attr = highlightedLine {
            Text(AttributedString(attr))
        } else {
            Text(sign + line.text).foregroundColor(fg)
        }
    }

    /// The syntax-highlighted attributed line (foreground tokens), prefixed with the
    /// diff sign, or nil to fall back to plain diff coloring (binary/large/no blob).
    private var highlightedLine: NSAttributedString? {
        guard let cwd, let anchor = HighlightMap.sourceLine(for: line) else { return nil }
        guard let blob = DiffReader.fileBlob(cwd: cwd, path: file.path, side: anchor.side, baseLabel: baseLabel),
              let lines = DiffSyntaxHighlighter.lines(forBlob: blob, path: file.path, side: anchor.side),
              anchor.lineNo - 1 >= 0, anchor.lineNo - 1 < lines.count else { return nil }
        let m = NSMutableAttributedString(string: sign)
        m.append(lines[anchor.lineNo - 1])
        return m
    }

    private func promptComment() {
        guard let anchor = HighlightMap.sourceLine(for: line) else { return }
        let alert = NSAlert()
        alert.messageText = "Comment on \(file.path):\(anchor.lineNo)"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        alert.accessoryView = field
        alert.addButton(withTitle: "Add"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn, !field.stringValue.isEmpty {
            model.addComment(file: file.path, line: anchor.lineNo, side: anchor.side, text: field.stringValue)
        }
    }

    private var sign: String {
        switch line.kind { case .added: return "+"; case .removed: return "-"; case .context: return " " }
    }
    private var gutter: String {
        "\(line.oldLineNo.map(String.init) ?? " ") \(line.newLineNo.map(String.init) ?? " ")"
    }
    private var fg: Color {
        switch line.kind { case .added: return Theme.needsCheck; case .removed: return Theme.error
        case .context: return Theme.textSecondary }
    }
    private var bg: Color {
        switch line.kind {
        case .added: return Theme.needsCheck.opacity(0.10)
        case .removed: return Theme.error.opacity(0.10)
        case .context: return .clear
        }
    }
}
