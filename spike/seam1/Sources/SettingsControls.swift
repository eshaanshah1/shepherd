import SwiftUI
import AppKit

// MARK: - Window chrome

/// Reaches the hosting NSWindow and dresses it in Shepherd's chrome: transparent
/// full-size titlebar (traffic lights float over content), no title text, dragging
/// anywhere, ground background. Dropped into the settings root via `.background`.
struct SettingsWindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let w = view.window else { return }
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.styleMask.insert(.fullSizeContentView)
            w.isMovableByWindowBackground = true
            w.backgroundColor = NSColor(Theme.ground)
        }
    }
}

// MARK: - Layout helpers

/// A titled field group: dim label over its control, with an optional footnote.
struct SettingsField<Content: View>: View {
    let label: String
    var footnote: String? = nil
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.ui(10.5, .semibold)).tracking(0.6)
                .foregroundStyle(Theme.textDim)
            content
            if let f = footnote {
                Text(f).font(.ui(11)).foregroundStyle(Theme.textDim)
            }
        }
    }
}

/// A single labeled row (label left, control right) for compact settings.
struct SettingsRow<Control: View>: View {
    let label: String
    @ViewBuilder let control: Control
    var body: some View {
        HStack(spacing: 12) {
            Text(label).font(.ui(13)).foregroundStyle(Theme.textPrimary)
            Spacer(minLength: 12)
            control
        }
    }
}

// MARK: - Segmented control

/// A flat themed segmented picker — replaces the loud native blue one. The active
/// segment gets an accent-tinted pill; the rest stay quiet in the text ramp.
struct SettingsSegmented<T: Hashable>: View {
    let options: [(label: String, value: T)]
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 3) {
            ForEach(options.indices, id: \.self) { i in
                let opt = options[i]
                let active = opt.value == selection
                Text(opt.label)
                    .font(.ui(12, active ? .semibold : .medium))
                    .foregroundStyle(active ? Theme.accent : Theme.textSecondary)
                    .padding(.vertical, 5).padding(.horizontal, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(active ? Theme.accentWash(0.16) : .clear)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { selection = opt.value }
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

// MARK: - Text field

/// Themed single-line text field: surface2 fill, hairline border that lights to the
/// accent on focus. Fires `onCommit` on Return.
struct SettingsTextField: View {
    let placeholder: String
    @Binding var text: String
    var mono: Bool = false
    var onCommit: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(mono ? .mono(12.5) : .ui(13))
            .foregroundStyle(Theme.textPrimary)
            .focused($focused)
            .onSubmit(onCommit)
            .padding(.vertical, 7).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface2))
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(focused ? Theme.accent.opacity(0.7) : Theme.hairline,
                                  lineWidth: focused ? 1.5 : 1)
            )
    }
}

// MARK: - Stepper

/// A compact − / value / + stepper.
struct SettingsStepper: View {
    @Binding var value: Int
    let range: ClosedRange<Int>
    var onChange: (Int) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 0) {
            stepButton("minus") { set(value - 1) }
            Text("\(value)")
                .font(.mono(12.5)).foregroundStyle(Theme.textPrimary)
                .frame(minWidth: 26)
            stepButton("plus") { set(value + 1) }
        }
        .padding(.vertical, 3).padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.hairline, lineWidth: 1))
    }

    private func set(_ v: Int) {
        let c = min(max(v, range.lowerBound), range.upperBound)
        if c != value { value = c; onChange(c) }
    }

    private func stepButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Toggle

/// A themed switch. On = accent track, off = surface3.
struct SettingsToggle: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(spacing: 12) {
                Text(label).font(.ui(13)).foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 12)
                ZStack(alignment: isOn ? .trailing : .leading) {
                    Capsule().fill(isOn ? Theme.accent : Theme.surface3)
                        .frame(width: 36, height: 20)
                    Circle().fill(Color.white.opacity(isOn ? 0.95 : 0.6))
                        .frame(width: 15, height: 15).padding(.horizontal, 2.5)
                }
                .animation(.easeOut(duration: 0.14), value: isOn)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Button

/// Flat themed button. `prominent` fills with the accent; otherwise a bordered
/// surface that lifts on hover.
struct SettingsButton: View {
    let title: String
    var systemImage: String? = nil
    var prominent: Bool = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let s = systemImage { Image(systemName: s).font(.system(size: 11, weight: .semibold)) }
                Text(title).font(.ui(12, .medium))
            }
            .foregroundStyle(prominent ? Color.white : Theme.textPrimary)
            .padding(.vertical, 6).padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(prominent ? Theme.accent : (hover ? Theme.surface3 : Theme.surface2))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(prominent ? .clear : Theme.hairline, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

// MARK: - Path validity

/// A cheap, pure classification of a user-entered path for the inline hint under
/// directory fields. No git shell-out — a `.git` entry is enough to call it a repo.
enum PathValidity {
    case empty, missing, folder, gitRepo

    static func classify(_ raw: String) -> PathValidity {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return .empty }
        let expanded = (t as NSString).expandingTildeInPath
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir), isDir.boolValue
        else { return .missing }
        let git = (expanded as NSString).appendingPathComponent(".git")
        return FileManager.default.fileExists(atPath: git) ? .gitRepo : .folder
    }

    var hint: (text: String, color: Color)? {
        switch self {
        case .empty:   return nil
        case .missing: return ("Doesn't exist yet", Theme.blocked)
        case .folder:  return ("Folder", Theme.needsCheck)
        case .gitRepo: return ("Git work tree", Theme.needsCheck)
        }
    }
}

/// The inline validity hint row shown under a directory field.
struct PathHint: View {
    let path: String
    var body: some View {
        if let h = PathValidity.classify(path).hint {
            HStack(spacing: 5) {
                Circle().fill(h.color).frame(width: 6, height: 6)
                Text(h.text).font(.ui(11)).foregroundStyle(Theme.textDim)
            }
        }
    }
}
