import XCTest
@testable import Shepherd

final class PRCommentsTests: XCTestCase {
    private func json(_ s: String) -> Data { Data(s.utf8) }

    // MARK: parse

    func testParsesThreadsWithRepliesAndSides() {
        let threads = PRThreads.parse(json("""
        {"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
          {"id":"T1","isResolved":false,"isOutdated":false,"path":"a.swift","line":10,"diffSide":"RIGHT",
           "comments":{"nodes":[
             {"id":"C1","databaseId":100,"body":"root","createdAt":"2026-07-16T10:00:00Z","author":{"login":"alice"}},
             {"id":"C2","databaseId":101,"body":"reply","createdAt":"2026-07-16T11:00:00Z","author":{"login":"bob"}}
           ]}},
          {"id":"T2","isResolved":true,"isOutdated":true,"path":"b.swift","line":null,"diffSide":"LEFT",
           "comments":{"nodes":[
             {"id":"C3","databaseId":102,"body":"old","createdAt":"2026-07-15T09:00:00Z","author":{"login":"carol"}}
           ]}}
        ]}}}}}
        """))
        XCTAssertEqual(threads.count, 2)
        XCTAssertEqual(threads[0].id, "T1")
        XCTAssertEqual(threads[0].line, 10)
        XCTAssertEqual(threads[0].side, .new)
        XCTAssertFalse(threads[0].isResolved)
        XCTAssertEqual(threads[0].comments.count, 2)
        XCTAssertEqual(threads[0].comments.first?.author, "alice")
        XCTAssertEqual(threads[1].line, nil)          // outdated -> nil line
        XCTAssertEqual(threads[1].side, .old)          // LEFT -> .old
        XCTAssertTrue(threads[1].isResolved)
        XCTAssertTrue(threads[1].isOutdated)
    }

    func testParseDegradesOnMissingFields() {
        let threads = PRThreads.parse(json("""
        {"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
          {"id":"T1","path":"a.swift","comments":{"nodes":[{"id":"C1","body":"hi"}]}}
        ]}}}}}
        """))
        XCTAssertEqual(threads.count, 1)
        XCTAssertEqual(threads[0].side, .new)          // missing diffSide -> .new
        XCTAssertFalse(threads[0].isResolved)          // missing -> false
        XCTAssertNil(threads[0].line)
        XCTAssertEqual(threads[0].comments.first?.author, "")  // missing author -> ""
        XCTAssertNil(threads[0].comments.first?.databaseId)
    }

    func testParseNullPullRequestAndGarbage() {
        XCTAssertEqual(PRThreads.parse(json(#"{"data":{"repository":{"pullRequest":null}}}"#)), [])
        XCTAssertEqual(PRThreads.parse(json("{}")), [])
        XCTAssertEqual(PRThreads.parse(json("not json")), [])
    }

    // MARK: ownerRepo

    func testOwnerRepoParsing() {
        XCTAssertTrue(PRThreads.ownerRepo(fromURL: "https://github.com/octo/hello/pull/42")! == ("octo", "hello"))
        XCTAssertTrue(PRThreads.ownerRepo(fromURL: "https://ghe.corp.example/team/repo/pull/1")! == ("team", "repo"))
        XCTAssertNil(PRThreads.ownerRepo(fromURL: "https://github.com/octo"))
        XCTAssertNil(PRThreads.ownerRepo(fromURL: "garbage"))
    }

    // MARK: unresolvedCount

    func testUnresolvedCount() {
        func thread(_ id: String, resolved: Bool) -> GHReviewThread {
            GHReviewThread(id: id, path: "a", line: 1, side: .new,
                           isResolved: resolved, isOutdated: false, comments: [])
        }
        XCTAssertEqual(PRThreads.unresolvedCount([]), 0)
        XCTAssertEqual(PRThreads.unresolvedCount([thread("a", resolved: true), thread("b", resolved: true)]), 0)
        XCTAssertEqual(PRThreads.unresolvedCount([thread("a", resolved: false), thread("b", resolved: true)]), 1)
    }
}
