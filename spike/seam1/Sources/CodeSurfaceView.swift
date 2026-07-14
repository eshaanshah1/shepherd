import SwiftUI
import AppKit
import CodeEditSourceEditor
import CodeEditLanguages

/// The code surface: a VSCode-style mini editor — file tree, open-file tabs, and
/// the active file in a native CodeEditSourceEditor. All CESE use is behind
/// `CodeEditorView` so the library stays swappable.
struct CodeSurfaceView: View {
    @EnvironmentObject var store: AgentStore
    let state: CodeSurfaceState

    var body: some View {
        HStack(spacing: 0) {
            if let root = state.rootPath {
                FileTreeView(root: root, activeFile: state.activeFile) { store.openFile($0) }
                    .frame(width: 220)
                Rectangle().fill(Theme.hairline).frame(width: 1)
            }
            VStack(spacing: 0) {
                tabStrip
                Rectangle().fill(Theme.hairline).frame(height: 1)
                if let active = state.activeFile {
                    CodeEditorView(
                        filePath: active,
                        onDirty: { store.markCodeSurfaceDirty(active) },
                        onSave: { store.saveActiveFile($0) }
                    )
                    .id(active)   // switching files re-inits the editor → reloads content
                } else {
                    VStack {
                        Text("Select a file from the tree").foregroundColor(Theme.textDim).font(.system(size: 13))
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Theme.ground)
    }

    private var tabStrip: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(state.openFiles, id: \.self) { path in
                        EditorTab(
                            name: state.displayName(path),
                            isActive: path == state.activeFile,
                            isDirty: state.isDirty(path),
                            onSelect: { store.selectFile(path) },
                            onClose: { store.closeFile(path) }
                        )
                    }
                }
            }
            Spacer(minLength: 0)
            Button { store.closeCodeSurface() } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain).foregroundColor(Theme.textSecondary).padding(.horizontal, 12).focusable(false)
            .help("Close editor")
        }
        .frame(height: 34)
        .background(Theme.surface1)
    }
}

private struct EditorTab: View {
    let name: String
    let isActive: Bool
    let isDirty: Bool
    var onSelect: () -> Void
    var onClose: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            Text(name).font(.system(size: 12))
                .foregroundColor(isActive ? Theme.textPrimary : Theme.textSecondary).lineLimit(1)
            Button(action: onClose) {
                Image(systemName: (isDirty && !hover) ? "circle.fill" : "xmark")
                    .font(.system(size: (isDirty && !hover) ? 7 : 9, weight: .semibold))
                    .foregroundColor(Theme.textDim)
            }
            .buttonStyle(.plain).focusable(false)
            .opacity((isDirty || hover) ? 1 : 0.001)
        }
        .padding(.horizontal, 12).frame(height: 34)
        .background(isActive ? Theme.ground : Theme.surface1)
        .overlay(alignment: .bottom) {
            if isActive { Rectangle().fill(Theme.accent).frame(height: 2) }
        }
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.hairline).frame(width: 1) }
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
        .onHover { hover = $0 }
    }
}

/// The CESE editor for one file. Text is seeded in `init` (before CESE reads the
/// binding in makeNSViewController) — CESE applies the text binding only once at
/// creation and never re-syncs it, so loading via onAppear left the editor blank.
struct CodeEditorView: View {
    let filePath: String
    var onDirty: () -> Void
    var onSave: (String) -> Void

    @State private var text: String
    @State private var editorState = SourceEditorState()

    init(filePath: String, onDirty: @escaping () -> Void, onSave: @escaping (String) -> Void) {
        self.filePath = filePath
        self.onDirty = onDirty
        self.onSave = onSave
        _text = State(initialValue: (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? "")
    }

    private var language: CodeLanguage {
        CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: filePath))
    }

    private var configuration: SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(
                theme: shepherdEditorTheme,
                font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                wrapLines: false
            ),
            behavior: .init(isEditable: true),
            // Drop the persistent fold ribbon (CESE couples the fold chevron to the
            // bar — no hover-only mode without forking). Folding isn't needed here.
            peripherals: .init(showFoldingRibbon: false)
        )
    }

    var body: some View {
        SourceEditor($text, language: language, configuration: configuration, state: $editorState)
            .onChange(of: text) { _ in onDirty() }
            .onReceive(NotificationCenter.default.publisher(for: .shepherdSaveCodeSurface)) { _ in
                onSave(text)
            }
    }
}

extension Notification.Name {
    static let shepherdSaveCodeSurface = Notification.Name("shepherd.codeSurface.save")
}

/// Editor theme matching the diff's `atom-one-dark` (HighlighterSwift) palette, so
/// syntax colors read identically between the diff and the editor. Background stays
/// Shepherd `ground` to match the app chrome (the diff panel sits on it too).
private var shepherdEditorTheme: EditorTheme {
    func attr(_ hex: UInt32) -> EditorTheme.Attribute { .init(color: NSColor(hex: hex)) }
    return EditorTheme(
        text: attr(0xABB2BF),
        insertionPoint: NSColor(hex: 0x528BFF),
        invisibles: attr(0x3B4048),
        background: NSColor(hex: 0x0F0F11),
        lineHighlight: NSColor(hex: 0x2C313A),
        selection: NSColor(hex: 0x3E4451),
        keywords: attr(0xC678DD),
        commands: attr(0x56B6C2),
        types: attr(0xE5C07B),
        attributes: attr(0xD19A66),
        variables: attr(0xE06C75),
        values: attr(0x56B6C2),
        numbers: attr(0xD19A66),
        strings: attr(0x98C379),
        characters: attr(0x98C379),
        comments: attr(0x5C6370)
    )
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
