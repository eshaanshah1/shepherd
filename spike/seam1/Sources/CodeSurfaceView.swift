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

    /// The terminal grid's mono face (JetBrains Mono), so the editor matches the
    /// diff and the terminal. Falls back to the system mono if it can't load.
    private var editorFont: NSFont {
        NSFont(name: Theme.monoFontName ?? "", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    }

    private var configuration: SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(
                theme: shepherdEditorTheme,
                font: editorFont,
                wrapLines: Theme.editorWrapLines
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

/// A small syntax-highlighted code field bound to in-memory text (no file), used by
/// Settings for the worktree-hook editor. Same CESE engine + Shepherd theme as the
/// full editor, so bash reads in the app's palette. Recreate via `.id(...)` to reseed
/// (CESE reads the binding only at init — see `CodeEditorView`).
struct CodeFieldView: View {
    @Binding var text: String
    var language: CodeLanguage = .bash
    @State private var editorState = SourceEditorState()

    private var editorFont: NSFont {
        NSFont(name: Theme.monoFontName ?? "", size: 12.5)
            ?? NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    }

    private var configuration: SourceEditorConfiguration {
        SourceEditorConfiguration(
            appearance: .init(theme: shepherdEditorTheme, font: editorFont, wrapLines: true),
            behavior: .init(isEditable: true),
            peripherals: .init(showGutter: false, showFoldingRibbon: false)
        )
    }

    var body: some View {
        SourceEditor($text, language: language, configuration: configuration, state: $editorState)
    }
}

/// The editor theme, built from Shepherd's own `Theme.Code` palette. The diff renders
/// from the same palette, so syntax reads identically between the two surfaces.
/// Background is Shepherd `ground`, matching the app chrome and the diff panel.
private var shepherdEditorTheme: EditorTheme {
    func attr(_ hex: UInt32) -> EditorTheme.Attribute { .init(color: NSColor(hex: hex)) }
    return EditorTheme(
        text: attr(Theme.Code.text),
        insertionPoint: NSColor(hex: Theme.Code.keyword),
        invisibles: attr(Theme.pickHex(dark: 0x3B4048, light: 0xC8C8C4, warm: 0xCFC6B0)),
        background: NSColor(hex: Theme.pickHex(dark: 0x0F0F11, light: 0xFBFBF9, warm: 0xFAF4E6)),
        lineHighlight: NSColor(hex: Theme.pickHex(dark: 0x1A1A1E, light: 0xEEEEEC, warm: 0xECE3CD)),
        selection: NSColor(hex: Theme.pickHex(dark: 0x2E2E36, light: 0xD6E4FB, warm: 0xE0D3B4)),
        keywords: attr(Theme.Code.keyword),
        commands: attr(Theme.Code.function),
        types: attr(Theme.Code.type),
        attributes: attr(Theme.Code.type),
        variables: attr(Theme.Code.variable),
        values: attr(Theme.Code.number),
        numbers: attr(Theme.Code.number),
        strings: attr(Theme.Code.string),
        characters: attr(Theme.Code.string),
        comments: attr(Theme.Code.comment)
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
