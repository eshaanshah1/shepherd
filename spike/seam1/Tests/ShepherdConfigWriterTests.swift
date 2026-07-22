import XCTest
@testable import Shepherd

final class ShepherdConfigWriterTests: XCTestCase {
    func testInsertNativeKeyIntoEmpty() {
        let out = ShepherdConfigWriter.apply(contents: "",
            sets: [ConfigEdit(key: "font-family", kind: .native, value: "JetBrains Mono")])
        XCTAssertEqual(out, "font-family = JetBrains Mono\n")
    }

    func testInsertShepherdKeyAsComment() {
        let out = ShepherdConfigWriter.apply(contents: "",
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "light")])
        XCTAssertEqual(out, "# shepherd: theme = light\n")
    }

    func testUpdateExistingNativeKeyInPlace() {
        let src = "font-family = Menlo\nfont-size = 13\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "font-family", kind: .native, value: "JetBrains Mono")])
        XCTAssertEqual(out, "font-family = JetBrains Mono\nfont-size = 13\n")
    }

    func testUpdateExistingShepherdKeyInPlace() {
        let src = "# shepherd: theme = dark\nfont-size = 13\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "warm")])
        XCTAssertEqual(out, "# shepherd: theme = warm\nfont-size = 13\n")
    }

    func testPreservesUnrelatedLinesAndComments() {
        let src = "# my notes\nkeybind = ctrl+a\n\n# shepherd: theme = dark\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "font-size", kind: .native, value: "14")])
        XCTAssertEqual(out,
            "# my notes\nkeybind = ctrl+a\n\n# shepherd: theme = dark\nfont-size = 14\n")
    }

    func testShepherdEditDoesNotMatchNativeKeyOfSameName() {
        let src = "theme = dark\n"
        let out = ShepherdConfigWriter.apply(contents: src,
            sets: [ConfigEdit(key: "theme", kind: .shepherd, value: "light")])
        XCTAssertEqual(out, "theme = dark\n# shepherd: theme = light\n")
    }

    func testIdempotentReapply() {
        let edit = ConfigEdit(key: "theme", kind: .shepherd, value: "light")
        let once = ShepherdConfigWriter.apply(contents: "", sets: [edit])
        let twice = ShepherdConfigWriter.apply(contents: once, sets: [edit])
        XCTAssertEqual(once, twice)
    }

    func testGetShepherdKey() {
        let text = "font-size = 13\n# shepherd: theme = dark\n"
        XCTAssertEqual(ShepherdConfigWriter.get("theme", from: text), "dark")
    }
    func testGetNativeKey() {
        XCTAssertEqual(ShepherdConfigWriter.get("font-size", from: "font-size = 13\n"), "13")
    }
    func testGetMissingKeyIsNil() {
        XCTAssertNil(ShepherdConfigWriter.get("theme", from: "font-size = 13\n"))
    }
    func testKindClassification() {
        XCTAssertEqual(ShepherdConfigWriter.kind(for: "theme"), .shepherd)
        XCTAssertEqual(ShepherdConfigWriter.kind(for: "font-size"), .native)
    }
}
