import Foundation

/// Starting an agent with a prompt already in hand. The prompt is written to a file and
/// read back by the shell rather than typed, because a typed newline is an Enter press.
enum AgentLaunch {

    /// One line: read the file into a variable, delete it, hand it to the agent as a
    /// single quoted argv entry. `file` is a path Shepherd owns, so the single-quoting
    /// never wraps user input.
    static func command(promptFile file: String, program: String = "claude") -> String {
        "p=$(cat '\(file)'); rm -f '\(file)'; \(program) \"$p\"\n"
    }

    /// Write the prompt somewhere the shell can read it back. nil if it is blank.
    static func prepare(prompt: String, dir: String = AppMode.supportPath("prompts")) -> String? {
        let text = prompt.trimmed
        guard !text.isEmpty else { return nil }
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = (dir as NSString).appendingPathComponent(UUID().uuidString + ".txt")
        guard (try? text.write(toFile: path, atomically: true, encoding: .utf8)) != nil
        else { return nil }
        return path
    }

    /// The `initial_input` that launches an agent already working on `prompt`, or nil for
    /// a plain shell.
    static func launchCommand(prompt: String,
                              dir: String = AppMode.supportPath("prompts")) -> String? {
        guard let file = prepare(prompt: prompt, dir: dir) else { return nil }
        return command(promptFile: file)
    }
}
