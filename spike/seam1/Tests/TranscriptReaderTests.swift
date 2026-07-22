import XCTest
@testable import Shepherd

final class TranscriptReaderTests: XCTestCase {
    func testKeepsUserAndAssistantSkipsToolNoise() {
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"run the tests"}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"Running now."}]}}"#,
            #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#,   // tool result -> skipped
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,                 // no text -> skipped
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"12 passing."}]}}"#,
        ]
        let turns = TranscriptReader.turns(fromJSONL: lines, limit: 10)
        XCTAssertEqual(turns, [
            TranscriptTurn(role: "user", text: "run the tests"),
            TranscriptTurn(role: "assistant", text: "Running now."),
            TranscriptTurn(role: "assistant", text: "12 passing."),
        ])
    }

    func testSkipsReminderOnlyAndCommandStubs() {
        let lines = [
            #"{"type":"user","message":{"role":"user","content":"<system-reminder>hi</system-reminder>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
            #"{"type":"user","message":{"role":"user","content":"real message"}}"#,
        ]
        XCTAssertEqual(TranscriptReader.turns(fromJSONL: lines, limit: 10),
                       [TranscriptTurn(role: "user", text: "real message")])
    }

    func testLimitReturnsLastN() {
        let lines = (1...5).map { #"{"type":"user","message":{"role":"user","content":"m\#($0)"}}"# }
        let turns = TranscriptReader.turns(fromJSONL: lines, limit: 2)
        XCTAssertEqual(turns.map(\.text), ["m4", "m5"])
    }
}
