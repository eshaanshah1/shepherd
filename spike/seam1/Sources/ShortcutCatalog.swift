import SwiftUI

/// Single source of truth for Shepherd's keyboard shortcuts. Both the menu bar
/// (`ShepherdApp.commands`) and the ⌘/ cheatsheet (`ShortcutCheatsheetView`)
/// render from this list, so a shortcut is declared exactly once and the two can
/// never drift. Pure data (no AgentStore/GhosttyApp refs) so it lives in
/// `ShepherdModelTests`; the action for each `id` is resolved app-side by an
/// exhaustive `switch` in `ShortcutActions`.
enum ShortcutCategory: String, CaseIterable {
    case tabsPanes  = "Tabs & Panes"
    case focusNav   = "Focus & Navigation"
    case workspaces = "Workspaces"
    case tools      = "Tools"
    case attention  = "Attention"
    case config     = "Config"
}

/// Stable identity for each command; the app maps this to a live action.
enum ShortcutID: CaseIterable {
    case newTab, newEphemeral, closePane, splitRight, splitDown, zoomPane
    case focusLeft, focusRight, focusUp, focusDown, prevTab, nextTab, jumpTab
    case newWorkspace, nextWorkspace, prevWorkspace
    case find, reviewDiff, openEditor, saveFile
    case nextAlert
    case reloadConfig, showShortcuts
}

struct ShortcutCommand: Identifiable {
    let id: ShortcutID
    let title: String
    /// nil ⇒ display-only (a key family the menu wires up by hand, e.g. ⌘1–9).
    let key: KeyEquivalent?
    let modifiers: EventModifiers
    let category: ShortcutCategory
    /// Precomputed keycap glyphs (⌘⇧A). Authored, not derived, so glyph mapping
    /// stays trivial and reviewable.
    let display: String
}

enum ShortcutCatalog {
    static let all: [ShortcutCommand] = [
        .init(id: .newTab,     title: "New Tab",     key: "t",     modifiers: .command,          category: .tabsPanes, display: "⌘T"),
        .init(id: .newEphemeral, title: "New Ephemeral Pane", key: "n", modifiers: [.command, .option], category: .tabsPanes, display: "⌘⌥N"),
        .init(id: .closePane,  title: "Close Pane",  key: "w",     modifiers: .command,          category: .tabsPanes, display: "⌘W"),
        .init(id: .splitRight, title: "Split Right", key: "d",     modifiers: .command,          category: .tabsPanes, display: "⌘D"),
        .init(id: .splitDown,  title: "Split Down",  key: "d",     modifiers: [.command, .shift], category: .tabsPanes, display: "⌘⇧D"),
        .init(id: .zoomPane,   title: "Zoom Pane",   key: .return, modifiers: [.command, .shift], category: .tabsPanes, display: "⌘⇧↩"),

        .init(id: .focusLeft,  title: "Focus Left",  key: .leftArrow,  modifiers: [.command, .option], category: .focusNav, display: "⌘⌥←"),
        .init(id: .focusRight, title: "Focus Right", key: .rightArrow, modifiers: [.command, .option], category: .focusNav, display: "⌘⌥→"),
        .init(id: .focusUp,    title: "Focus Up",    key: .upArrow,    modifiers: [.command, .option], category: .focusNav, display: "⌘⌥↑"),
        .init(id: .focusDown,  title: "Focus Down",  key: .downArrow,  modifiers: [.command, .option], category: .focusNav, display: "⌘⌥↓"),
        .init(id: .prevTab,    title: "Previous Tab", key: "[", modifiers: [.command, .shift], category: .focusNav, display: "⌘⇧["),
        .init(id: .nextTab,    title: "Next Tab",     key: "]", modifiers: [.command, .shift], category: .focusNav, display: "⌘⇧]"),
        .init(id: .jumpTab,    title: "Jump to Tab N", key: nil, modifiers: [], category: .focusNav, display: "⌘1–9"),

        .init(id: .newWorkspace,  title: "New Workspace",      key: "n",  modifiers: [.command, .shift],   category: .workspaces, display: "⌘⇧N"),
        .init(id: .nextWorkspace, title: "Next Workspace",     key: .tab, modifiers: .control,             category: .workspaces, display: "⌃⇥"),
        .init(id: .prevWorkspace, title: "Previous Workspace", key: .tab, modifiers: [.control, .shift],   category: .workspaces, display: "⌃⇧⇥"),

        .init(id: .find,       title: "Find",        key: "f", modifiers: .command, category: .tools, display: "⌘F"),
        .init(id: .reviewDiff, title: "Review Diff", key: "g", modifiers: .command, category: .tools, display: "⌘G"),
        .init(id: .openEditor, title: "Open Editor", key: "o", modifiers: .command, category: .tools, display: "⌘O"),
        .init(id: .saveFile,   title: "Save File",   key: "s", modifiers: .command, category: .tools, display: "⌘S"),

        .init(id: .nextAlert, title: "Jump to Next Alert", key: "a", modifiers: [.command, .shift], category: .attention, display: "⌘⇧A"),

        .init(id: .reloadConfig,  title: "Reload Config",       key: "r", modifiers: [.command, .shift], category: .config, display: "⌘⇧R"),
        .init(id: .showShortcuts, title: "Keyboard Shortcuts",  key: "/", modifiers: .command,          category: .config, display: "⌘/"),
    ]

    /// Commands the menu bar generates a real `.keyboardShortcut` for (key != nil).
    static var menuCommands: [ShortcutCommand] { all.filter { $0.key != nil } }

    static func commands(in category: ShortcutCategory) -> [ShortcutCommand] {
        all.filter { $0.category == category }
    }
}
