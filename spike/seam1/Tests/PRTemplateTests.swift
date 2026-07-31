import XCTest

final class PRTemplateTests: XCTestCase {

    func testFindsRootTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: ["README.md", "pull_request_template.md"]),
                       "pull_request_template.md")
    }

    func testFindsDocsTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: ["docs/pull_request_template.md"]),
                       "docs/pull_request_template.md")
    }

    func testFindsGithubTemplate() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/pull_request_template.md"]),
                       ".github/pull_request_template.md")
    }

    /// Root beats docs beats .github — GitHub's own order.
    func testPrecedence() {
        let all = [".github/pull_request_template.md",
                   "docs/pull_request_template.md",
                   "pull_request_template.md"]
        XCTAssertEqual(PRTemplate.pick(from: all), "pull_request_template.md")
        XCTAssertEqual(PRTemplate.pick(from: Array(all.prefix(2))),
                       "docs/pull_request_template.md")
    }

    /// GitHub matches these case-insensitively, and SHOUTING is the common spelling.
    func testCaseInsensitive() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE.md"]),
                       ".github/PULL_REQUEST_TEMPLATE.md")
        XCTAssertEqual(PRTemplate.pick(from: ["Pull_Request_Template.md"]),
                       "Pull_Request_Template.md")
    }

    /// A directory of templates is selectable only via GitHub's ?template= parameter.
    /// Picking one would silently apply the wrong convention.
    func testMultiTemplateDirectoryIsNotGuessed() {
        XCTAssertNil(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE/bug.md",
                                            ".github/PULL_REQUEST_TEMPLATE/feature.md"]))
    }

    /// A single-file template still wins even if a directory exists beside it.
    func testSingleFileBeatsDirectory() {
        XCTAssertEqual(PRTemplate.pick(from: [".github/PULL_REQUEST_TEMPLATE/bug.md",
                                              "pull_request_template.md"]),
                       "pull_request_template.md")
    }

    func testNoTemplate() {
        XCTAssertNil(PRTemplate.pick(from: ["README.md", "src/main.swift"]))
        XCTAssertNil(PRTemplate.pick(from: []))
    }

    /// Not a template — the match must be against the whole path, not a prefix of it.
    func testUnrelatedFileNamedSimilarly() {
        XCTAssertNil(PRTemplate.pick(from: ["docs/pull_request_template_guide.md"]))
    }
}
