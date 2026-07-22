import Foundation

enum AnsiText {
    private static let csi = try! NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]")
    private static let osc = try! NSRegularExpression(pattern: "\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)")
    private static let other = try! NSRegularExpression(pattern: "\u{1B}[@-Z\\\\-_]")

    static func strip(_ s: String) -> String {
        var out = s
        for re in [osc, csi, other] {
            let range = NSRange(out.startIndex..., in: out)
            out = re.stringByReplacingMatches(in: out, range: range, withTemplate: "")
        }
        return out
    }

    static func tailLines(_ s: String, _ n: Int) -> String {
        guard n > 0 else { return "" }
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(n).joined(separator: "\n")
    }
}
