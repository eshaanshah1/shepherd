import XCTest

final class DataMessageTests: XCTestCase {
    private func roundTrip(_ m: DataMessage) throws -> [DataMessage] {
        let dec = DataFrameDecoder()
        return try dec.feed(try DataFrameCodec.encode(m))
    }

    func testEachCaseRoundTrips() throws {
        let cases: [DataMessage] = [
            .dataHello(sessionNonce: "n0nce", paneID: "pane-abc"),
            .dataReady(cols: 120, rows: 40),
            .dataRejected(reason: "bad nonce"),
            .ptyHello(paneID: "pane-abc", cols: 80, rows: 24),
        ]
        for c in cases { XCTAssertEqual(try roundTrip(c), [c]) }
    }

    func testTwoFramesInOneFeedDecodeInOrder() throws {
        var data = try DataFrameCodec.encode(.ptyHello(paneID: "p", cols: 80, rows: 24))
        data.append(try DataFrameCodec.encode(.dataReady(cols: 80, rows: 24)))
        let msgs = try DataFrameDecoder().feed(data)
        XCTAssertEqual(msgs, [.ptyHello(paneID: "p", cols: 80, rows: 24), .dataReady(cols: 80, rows: 24)])
    }

    func testPartialFrameBuffersUntilComplete() throws {
        let full = try DataFrameCodec.encode(.dataReady(cols: 80, rows: 24))
        let dec = DataFrameDecoder()
        XCTAssertEqual(try dec.feed(full.prefix(3)), [])         // len not even fully read
        XCTAssertEqual(try dec.feed(full.suffix(from: 3)), [.dataReady(cols: 80, rows: 24)])
    }
}
