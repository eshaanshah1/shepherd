import XCTest
@testable import Shepherd

final class PairingPayloadTests: XCTestCase {
    func testEncodePinnedString() {
        let s = PairingPayload.encode(host: "work.tail1234.ts.net", ip: "100.78.141.27",
                                      port: 8722, name: "work")
        XCTAssertEqual(s, "shepherd://pair?host=work.tail1234.ts.net&ip=100.78.141.27&port=8722&name=work")
    }
    func testEncodeOmitsEmptyHostAndIP() {
        let s = PairingPayload.encode(host: nil, ip: "100.64.0.5", port: 8722, name: "mac")
        XCTAssertEqual(s, "shepherd://pair?ip=100.64.0.5&port=8722&name=mac")
    }
}
