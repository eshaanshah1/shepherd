import AppKit

struct PRDraft {
    var title: String
    var body: String
    var draft: Bool
}

/// Mirrors `GitResult`'s shape rather than using `Result`, whose failure type must be an
/// `Error` — the message here is git's or gh's stderr, already human-readable.
enum PRCreateResult: Equatable {
    case created(url: String)
    case failed(String)
}

/// Asks for a PR's title and body, then creates it.
///
/// Shepherd asks rather than passing `gh pr create --fill`, whose multi-commit title falls
/// back to a heuristic off the branch name — creating a PR is outward-facing and hard to
/// undo, so nothing is published that the user did not see. `--editor` is not an option
/// either: an app-spawned `Process` has no tty, so it would not fail, it would hang.
enum PRCreateDialog {

    /// Title from the last commit, body from the repo's template.
    static func prefill(cwd: String) -> PRDraft {
        var title = ""
        if case .ok(let subject) = GitStaging.run(["log", "-1", "--format=%s"], cwd: cwd) {
            title = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return PRDraft(title: title,
                       body: PRTemplate.body(inRepo: cwd) ?? "",
                       draft: false)
    }

    /// nil when cancelled. Must run on the main thread.
    @MainActor
    static func prompt(_ initial: PRDraft, branch: String?, ahead: Int) -> PRDraft? {
        let alert = NSAlert()
        alert.messageText = "Create pull request"
        alert.informativeText = "\(ahead) commit\(ahead == 1 ? "" : "s") on "
            + "\(branch ?? "this branch") with no pull request."
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let title = NSTextField(string: initial.title)
        title.placeholderString = "Title"

        // A template is routinely 40+ lines, so the body scrolls rather than growing the
        // alert past the screen.
        let bodyView = NSTextView()
        bodyView.string = initial.body
        bodyView.isRichText = false
        bodyView.isEditable = true
        bodyView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = bodyView

        let draftBox = NSButton(checkboxWithTitle: "Draft", target: nil, action: nil)
        draftBox.state = initial.draft ? .on : .off

        let stack = NSStackView(views: [title, scroll, draftBox])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = true
        stack.frame = NSRect(x: 0, y: 0, width: 420, height: 176)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.heightAnchor.constraint(equalToConstant: 120),
            scroll.widthAnchor.constraint(equalToConstant: 420),
            title.widthAnchor.constraint(equalToConstant: 420),
        ])
        alert.accessoryView = stack
        alert.window.initialFirstResponder = title

        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let text = title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return PRDraft(title: text, body: bodyView.string, draft: draftBox.state == .on)
    }

    /// Push if the branch has no upstream, then create. Returns the PR's URL.
    ///
    /// Synchronous — callers dispatch it off the main thread.
    static func create(_ draft: PRDraft, cwd: String) -> PRCreateResult {
        guard let gh = GH.executablePath else { return .failed("gh is not installed") }

        if GitStaging.upstream(cwd: cwd) == nil {
            guard let branch = GitStaging.currentBranch(cwd: cwd) else {
                return .failed("Detached HEAD — check out a branch first.")
            }
            let push = GitStaging.run(["push", "-u", "origin", branch], cwd: cwd)
            if let err = push.errorText { return .failed(err) }
        }

        var args = ["pr", "create", "--title", draft.title, "--body-file", "-"]
        if draft.draft { args.append("--draft") }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        let input = Pipe(), out = Pipe(), err = Pipe()
        p.standardInput = input
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return .failed("\(error)") }

        // The body reaches gh on stdin, not argv: a template is markdown full of backticks
        // and quotes, and there is no argument length to worry about this way.
        input.fileHandleForWriting.write(Data(draft.body.utf8))
        input.fileHandleForWriting.closeFile()
        // Drain before waiting — a full pipe deadlocks the child.
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(),
                            encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(),
                            encoding: .utf8) ?? ""
        p.waitUntilExit()

        guard p.terminationStatus == 0 else {
            return .failed(stderr.isEmpty ? stdout : stderr)
        }
        let url = stdout.split(separator: "\n")
            .last { $0.hasPrefix("http") }
            .map(String.init) ?? ""
        return .created(url: url)
    }
}
