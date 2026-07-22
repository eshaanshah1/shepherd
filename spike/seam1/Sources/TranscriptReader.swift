import Foundation

struct TranscriptTurn: Equatable { let role: String; let text: String }

/// Parses Claude Code session JSONL into clean user/assistant turns, dropping
/// tool calls/results, hook/reminder stubs, and command-echo stubs. Mirrors the
/// `recall` CLI's filtering; reimplemented here so Shepherd stays self-contained.
enum TranscriptReader {
    static func turns(fromJSONL lines: [String], limit: Int) -> [TranscriptTurn] {
        var out: [TranscriptTurn] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, let data = t.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String,
                  let msg = obj["message"] as? [String: Any]
            else { continue }
            if type == "user", let text = userText(msg) {
                out.append(TranscriptTurn(role: "user", text: text))
            } else if type == "assistant", let text = assistantText(msg) {
                out.append(TranscriptTurn(role: "assistant", text: text))
            }
        }
        return limit > 0 && out.count > limit ? Array(out.suffix(limit)) : out
    }

    private static func userText(_ msg: [String: Any]) -> String? {
        guard let content = msg["content"] as? String else { return nil }  // tool_result content is an array -> skipped
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.hasPrefix("<local-command-stdout>") { return nil }
        let stripped = text.replacingOccurrences(
            of: "<[^>]+>.*?</[^>]+>", with: "", options: [.regularExpression]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        return stripped.isEmpty ? nil : text
    }

    private static func assistantText(_ msg: [String: Any]) -> String? {
        guard let blocks = msg["content"] as? [[String: Any]] else { return nil }
        let parts = blocks.compactMap { b -> String? in
            guard b["type"] as? String == "text",
                  let t = (b["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !t.isEmpty else { return nil }
            return t
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    /// Locate `<sessionID>.jsonl` under `<projectsDir>/*/`. Returns the first match.
    static func sessionFile(sessionID: String, projectsDir: String) -> String? {
        let fm = FileManager.default
        guard let projects = try? fm.contentsOfDirectory(atPath: projectsDir) else { return nil }
        for proj in projects {
            let candidate = (projectsDir as NSString)
                .appendingPathComponent(proj)
                .appending("/\(sessionID).jsonl")
            if fm.fileExists(atPath: candidate) { return candidate }
        }
        return nil
    }
}
