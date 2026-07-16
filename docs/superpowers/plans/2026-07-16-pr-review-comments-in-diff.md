# GitHub PR Review Comments in Diff Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull a PR's inline GitHub review comments into Shepherd's diff panel next to local comments, with reply / resolve / send-to-agent, a red sidebar unresolved-count badge, and the `reviewRequired` eye icon removed.

**Architecture:** A pure model (`PRComments.swift`) parses the `gh api graphql` `reviewThreads` payload. `GH` (in `GitHubService.swift`) shells out for the query + reply/resolve mutations. `AgentStore` caches threads per-pane (`reviewThreads`, next to `prStatuses`), fetched on the same triggers as PR status, and orchestrates mutations. `DiffPanelView` renders threads inline in vs-base mode; `SidebarView` shows the unresolved badge. Local comments stay agent-bound; a GitHub-sourced comment can also be appended to the same "Send to agent" batch.

**Tech Stack:** Swift, SwiftUI, AppKit, `gh` CLI (GraphQL), xcodegen, XCTest.

## Global Constraints

- **Work in `spike/seam1/`** — the real app. All paths below are relative to it unless absolute.
- **`xcodegen generate` after adding/removing any source file** (before building), else the file isn't compiled.
- **Pure model files** (`PRComments.swift`) go in the `ShepherdModelTests` target's explicit `sources:` list in `project.yml` AND are testable via `@testable import Shepherd`. Test files under `Tests/` are auto-globbed.
- **`GH` shell + SwiftUI views are NOT unit-tested** — matches the existing `GH`/`PRStatus` split. Their verification is a clean `xcodebuild` + model tests green; **runtime verification is deferred to the user — do NOT `killall`/relaunch Shepherd** (it's the user's live daily terminal).
- **libghostty C API + all published-state mutations happen on the main thread**; `Process`/`gh` work runs off-main.
- **The env var name stays `SHEPHERD_TAB_ID`** (unrelated here, do not touch).
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **`DiffSide`** (from `DiffModel.swift`): `.new` = GitHub `RIGHT`, `.old` = GitHub `LEFT`.

### Build & test commands (run from `spike/seam1/`)

Model tests:
```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -30
```

App build (for UI/integration tasks with no unit tests):
```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -30
```

---

## File Structure

- **Create** `Sources/PRComments.swift` — pure model: `GHReviewComment`, `GHReviewThread`, `enum PRThreads` (`parse`, `ownerRepo`, `unresolvedCount`).
- **Create** `Tests/PRCommentsTests.swift` — unit tests for the above.
- **Modify** `Sources/GitHubService.swift` — add `GH.reviewThreads` / `replyToThread` / `setThreadResolved`.
- **Modify** `Sources/DiffModel.swift` — `ReviewComment.githubAuthor`; `ReviewPrompt.compose` branch.
- **Modify** `Sources/AgentStore.swift` — `reviewThreads` cache + `refreshReviewThreads` + mutations + trigger wiring.
- **Modify** `Sources/SidebarView.swift` — `Tabler.message` + `Tabler.brandGithub`; remove `Tabler.eye`; badge state in `PRStatusIcon`; row wiring; remove `.reviewRequired` eye case.
- **Modify** `Sources/DiffPanelView.swift` — thread rendering (`GitHubThreadView`), anchoring, unanchored disclosure, reply/resolve/send-to-agent, `DiffReviewModel` UI state + `addGitHubComment`.
- **Modify** `project.yml` — add `Sources/PRComments.swift` to `ShepherdModelTests.sources`.

---

## Task 1: Pure model — `PRComments.swift`

**Files:**
- Create: `Sources/PRComments.swift`
- Create: `Tests/PRCommentsTests.swift`
- Modify: `project.yml` (add `- path: Sources/PRComments.swift` under `ShepherdModelTests.sources`, after the `PRStatus.swift` line)

**Interfaces:**
- Consumes: `DiffSide` from `Sources/DiffModel.swift` (already in the test target).
- Produces:
  - `struct GHReviewComment: Equatable, Identifiable { let id: String; let databaseId: Int?; let author: String; let body: String; let createdAt: String }`
  - `struct GHReviewThread: Equatable, Identifiable { let id: String; let path: String; let line: Int?; let side: DiffSide; let isResolved: Bool; let isOutdated: Bool; let comments: [GHReviewComment] }`
  - `PRThreads.parse(_ data: Data) -> [GHReviewThread]`
  - `PRThreads.ownerRepo(fromURL: String) -> (owner: String, repo: String)?`
  - `PRThreads.unresolvedCount(_ threads: [GHReviewThread]) -> Int`

- [ ] **Step 1: Add the model file to the test target in `project.yml`**

Under `ShepherdModelTests:` → `sources:`, add a line right after `- path: Sources/PRStatus.swift`:

```yaml
      - path: Sources/PRComments.swift
```

- [ ] **Step 2: Write `Sources/PRComments.swift`**

```swift
import Foundation

// MARK: - Pure core (unit-tested)

/// One GitHub PR review comment (thread root or a reply).
struct GHReviewComment: Equatable, Identifiable {
    let id: String            // GraphQL node id
    let databaseId: Int?
    let author: String        // login; "" when unknown
    let body: String
    let createdAt: String     // ISO8601 as returned; formatted at render time
}

/// One GitHub PR review thread anchored to a file:line, with its comments.
struct GHReviewThread: Equatable, Identifiable {
    let id: String            // GraphQL thread node id (reply/resolve target)
    let path: String
    let line: Int?            // nil when outdated / no longer maps to the diff
    let side: DiffSide        // RIGHT -> .new, LEFT -> .old
    let isResolved: Bool
    let isOutdated: Bool
    let comments: [GHReviewComment]   // first is the root, rest are replies
}

/// Pure parsing/reduction for PR review threads. Namespaced (like `PR`/`WorktreeArchive`)
/// so symbols don't clash with the app module under `@testable import`.
enum PRThreads {
    /// Parse `gh api graphql` output for the `repository.pullRequest.reviewThreads.nodes`
    /// query into threads. Defensive: a missing/null field degrades (nil line, "" author)
    /// rather than dropping the thread; a null pullRequest / undecodable data -> [].
    static func parse(_ data: Data) -> [GHReviewThread] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObj = obj["data"] as? [String: Any],
              let repo = dataObj["repository"] as? [String: Any],
              let pr = repo["pullRequest"] as? [String: Any],
              let rt = pr["reviewThreads"] as? [String: Any],
              let nodes = rt["nodes"] as? [[String: Any]] else { return [] }
        return nodes.map { node in
            let side: DiffSide = (node["diffSide"] as? String)?.uppercased() == "LEFT" ? .old : .new
            let commentNodes = ((node["comments"] as? [String: Any])?["nodes"] as? [[String: Any]]) ?? []
            let comments = commentNodes.map { c in
                GHReviewComment(
                    id: c["id"] as? String ?? "",
                    databaseId: c["databaseId"] as? Int,
                    author: ((c["author"] as? [String: Any])?["login"] as? String) ?? "",
                    body: c["body"] as? String ?? "",
                    createdAt: c["createdAt"] as? String ?? "")
            }
            return GHReviewThread(
                id: node["id"] as? String ?? "",
                path: node["path"] as? String ?? "",
                line: node["line"] as? Int,
                side: side,
                isResolved: node["isResolved"] as? Bool ?? false,
                isOutdated: node["isOutdated"] as? Bool ?? false,
                comments: comments)
        }
    }

    /// "https://github.com/{owner}/{repo}/pull/{n}" (or an enterprise host) -> (owner, repo).
    /// Takes the first two path components; nil if the path is too short.
    static func ownerRepo(fromURL url: String) -> (owner: String, repo: String)? {
        guard let comps = URLComponents(string: url) else { return nil }
        let parts = comps.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        return (parts[0], parts[1])
    }

    /// Count of threads not yet resolved — drives the sidebar badge.
    static func unresolvedCount(_ threads: [GHReviewThread]) -> Int {
        threads.filter { !$0.isResolved }.count
    }
}
```

- [ ] **Step 3: Write `Tests/PRCommentsTests.swift`**

```swift
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
```

- [ ] **Step 4: Regenerate + run tests, verify they pass**

```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/PRCommentsTests test 2>&1 | tail -30
```
Expected: `Test Suite 'PRCommentsTests' passed`, 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/PRComments.swift spike/seam1/Tests/PRCommentsTests.swift spike/seam1/project.yml
git commit -m "feat(diff): pure model for GitHub PR review threads

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `gh` shell — `GH.reviewThreads` / `replyToThread` / `setThreadResolved`

**Files:**
- Modify: `Sources/GitHubService.swift` (add methods inside `enum GH`, after `prStatus`)

**Interfaces:**
- Consumes: `GH.executablePath`, `GH.augmentedEnv` (existing, private); `PRThreads.parse` / `GHReviewThread` (Task 1).
- Produces:
  - `GH.reviewThreads(owner: String, repo: String, number: Int, inDir: String) -> [GHReviewThread]?`
  - `GH.replyToThread(id: String, body: String, inDir: String) -> Bool`
  - `GH.setThreadResolved(id: String, _ resolved: Bool, inDir: String) -> Bool`

> No unit test (matches the `GH.prStatus` split). Verification = the app target compiles.

- [ ] **Step 1: Add the three methods to `enum GH`** (in `Sources/GitHubService.swift`, after the closing brace of `prStatus(inDir:)`, before the final `}` of the enum)

```swift
    /// The PR's inline review threads via GraphQL (thread ids + resolved/outdated + comments
    /// in one call). Returns nil on a `gh` failure; [] when the PR has no threads. Off-main.
    static func reviewThreads(owner: String, repo: String, number: Int, inDir dir: String) -> [GHReviewThread]? {
        guard let gh = executablePath else { return nil }
        let query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line diffSide comments(first:100){nodes{id databaseId body createdAt author{login}}}}}}}}"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        p.arguments = ["api", "graphql", "-f", "query=\(query)",
                       "-f", "owner=\(owner)", "-f", "repo=\(repo)", "-F", "number=\(number)"]
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        p.environment = augmentedEnv
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return PRThreads.parse(data)
    }

    /// Post a reply into an existing review thread. True on success. Off-main.
    static func replyToThread(id: String, body: String, inDir dir: String) -> Bool {
        let mutation = "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}"
        return runGraphQL(query: mutation, stringVars: ["threadId": id, "body": body], inDir: dir)
    }

    /// Resolve / unresolve a review thread. True on success. Off-main.
    static func setThreadResolved(id: String, _ resolved: Bool, inDir dir: String) -> Bool {
        let field = resolved ? "resolveReviewThread" : "unresolveReviewThread"
        let mutation = "mutation($threadId:ID!){\(field)(input:{threadId:$threadId}){thread{id isResolved}}}"
        return runGraphQL(query: mutation, stringVars: ["threadId": id], inDir: dir)
    }

    /// Run a GraphQL mutation with string variables; true iff `gh` exits 0.
    private static func runGraphQL(query: String, stringVars: [String: String], inDir dir: String) -> Bool {
        guard let gh = executablePath else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: gh)
        var args = ["api", "graphql", "-f", "query=\(query)"]
        for (k, v) in stringVars { args += ["-f", "\(k)=\(v)"] }
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        p.environment = augmentedEnv
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        do { try p.run() } catch { return false }
        _ = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
```

- [ ] **Step 2: Build the app, verify it compiles**

```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/GitHubService.swift
git commit -m "feat(diff): gh shell for PR review threads (query + reply/resolve)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `ReviewComment.githubAuthor` + `ReviewPrompt.compose`

**Files:**
- Modify: `Sources/DiffModel.swift:146-163` (`ReviewComment` struct + `ReviewPrompt.compose`)
- Modify: `Tests/DiffModelTests.swift` (add one test)

**Interfaces:**
- Produces: `ReviewComment` gains `let githubAuthor: String? = nil` (nil = local). The default keeps existing `ReviewComment(id:file:line:side:text:)` call sites compiling via the synthesized memberwise init.

- [ ] **Step 1: Write the failing test** — add to `Tests/DiffModelTests.swift`, after `test_composesNumberedReviewPrompt`:

```swift
    func test_composesGitHubSourcedReviewPrompt() {
        let comments = [
            ReviewComment(id: UUID(), file: "src/foo.rb", line: 42, side: .new,
                          text: "handle nil here", githubAuthor: "alice"),
        ]
        let expected = """
        Review feedback on your changes:

        1. Address this PR review comment from @alice on src/foo.rb:42: handle nil here

        Please address these.
        """
        XCTAssertEqual(ReviewPrompt.compose(comments), expected)
    }
```

- [ ] **Step 2: Run it, verify it fails to compile**

```bash
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/DiffModelTests test 2>&1 | tail -20
```
Expected: compile failure — `extra argument 'githubAuthor' in call`.

- [ ] **Step 3: Add the field + compose branch** in `Sources/DiffModel.swift`.

Replace the `ReviewComment` struct:

```swift
struct ReviewComment: Equatable, Identifiable {
    let id: UUID
    let file: String
    let line: Int
    let side: DiffSide
    let text: String
    let githubAuthor: String? = nil   // set = sourced from a GitHub review thread; nil = local
}
```

Replace `ReviewPrompt.compose`:

```swift
enum ReviewPrompt {
    /// Compose accumulated comments into one prompt for the agent. Empty → "".
    /// GitHub-sourced entries are framed as review comments to address.
    static func compose(_ comments: [ReviewComment]) -> String {
        guard !comments.isEmpty else { return "" }
        let body = comments.enumerated().map { idx, c in
            if let author = c.githubAuthor {
                return "\(idx + 1). Address this PR review comment from @\(author) on \(c.file):\(c.line): \(c.text)"
            }
            return "\(idx + 1). \(c.file):\(c.line) — \(c.text)"
        }.joined(separator: "\n")
        return "Review feedback on your changes:\n\n\(body)\n\nPlease address these."
    }
}
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/DiffModelTests test 2>&1 | tail -20
```
Expected: `DiffModelTests` passes, including both `test_composesNumberedReviewPrompt` (unchanged) and the new `test_composesGitHubSourcedReviewPrompt`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/DiffModel.swift spike/seam1/Tests/DiffModelTests.swift
git commit -m "feat(diff): tag review comments as GitHub-sourced for the agent prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `AgentStore` — per-pane thread cache + mutations + triggers

**Files:**
- Modify: `Sources/AgentStore.swift` — add published cache + in-flight guard (near line 22-24); add methods after `refreshPR`/`openPR` (near line 489-495); wire a cascade into `refreshPR`.

**Interfaces:**
- Consumes: `GH.reviewThreads`/`replyToThread`/`setThreadResolved` (Task 2); `PRThreads.ownerRepo` (Task 1); existing `prStatuses`, `cwd(forPane:)`.
- Produces:
  - `AgentStore.reviewThreads: [String: [GHReviewThread]]` (published, `private(set)`)
  - `refreshReviewThreads(forPane paneID: String)`
  - `replyToThread(id: String, body: String, forPane paneID: String)`
  - `setThreadResolved(id: String, _ resolved: Bool, forPane paneID: String)`

> No unit test (AppKit `@MainActor` store). Verification = app compiles.

- [ ] **Step 1: Add the cache + in-flight guard.** In `Sources/AgentStore.swift`, right after the existing `@Published private(set) var prStatuses: [String: PRStatus] = [:]` (line 22):

```swift
    /// PR review threads per pane (keyed by pane id), fetched alongside PR status.
    @Published private(set) var reviewThreads: [String: [GHReviewThread]] = [:]
```

And next to `private var prInFlight: Set<String> = []` (line 23):

```swift
    private var reviewThreadsInFlight: Set<String> = []
```

- [ ] **Step 2: Cascade a thread fetch off a successful PR-status fetch.** In `refreshPR(forPane:)`, inside the main-thread completion block, after the `if let status { self.prStatuses[paneID] = status } else { ... }` lines, add an else-aware refresh:

Replace:
```swift
                if let status { self.prStatuses[paneID] = status }
                else { self.prStatuses.removeValue(forKey: paneID) }
```
with:
```swift
                if let status {
                    self.prStatuses[paneID] = status
                    self.refreshReviewThreads(forPane: paneID)   // PR exists → pull its review threads
                } else {
                    self.prStatuses.removeValue(forKey: paneID)
                    self.reviewThreads.removeValue(forKey: paneID)
                }
```

- [ ] **Step 3: Add the three methods** after `openPR(forPane:)` (near line 495):

```swift
    /// Fetch (off-main) the review threads for a pane's PR and cache them; clears the
    /// entry when there's no PR. Reads owner/repo from the cached PRStatus url. No-op
    /// without `gh` / a PR / a cwd, or while already fetching.
    func refreshReviewThreads(forPane paneID: String) {
        guard GH.isInstalled, !reviewThreadsInFlight.contains(paneID),
              let status = prStatuses[paneID],
              let cwd = cwd(forPane: paneID), !cwd.isEmpty,
              let (owner, repo) = PRThreads.ownerRepo(fromURL: status.url) else { return }
        reviewThreadsInFlight.insert(paneID)
        let number = status.number
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let threads = GH.reviewThreads(owner: owner, repo: repo, number: number, inDir: cwd)
            DispatchQueue.main.async {
                guard let self else { return }
                self.reviewThreadsInFlight.remove(paneID)
                if let threads { self.reviewThreads[paneID] = threads }
                else { self.reviewThreads.removeValue(forKey: paneID) }
            }
        }
    }

    /// Post a reply into a thread, then refetch to reconcile. Off-main.
    func replyToThread(id: String, body: String, forPane paneID: String) {
        guard let cwd = cwd(forPane: paneID), !cwd.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = GH.replyToThread(id: id, body: body, inDir: cwd)
            DispatchQueue.main.async { self?.refreshReviewThreads(forPane: paneID) }
        }
    }

    /// Resolve / unresolve a thread, then refetch to reconcile. Off-main.
    func setThreadResolved(id: String, _ resolved: Bool, forPane paneID: String) {
        guard let cwd = cwd(forPane: paneID), !cwd.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = GH.setThreadResolved(id: id, resolved, inDir: cwd)
            DispatchQueue.main.async { self?.refreshReviewThreads(forPane: paneID) }
        }
    }
```

- [ ] **Step 4: Build the app, verify it compiles**

```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(diff): cache PR review threads per pane; reply/resolve orchestration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Sidebar — `message` badge, `brand-github` glyph, remove eye

**Files:**
- Modify: `Sources/SidebarView.swift` — `Tabler` enum (add `message`, `brandGithub`; remove `eye`); `PRStatusIcon` (badge state + count param); row call site (line ~455); `paths(_:)` (remove `.reviewRequired` case).

**Interfaces:**
- Consumes: `PRThreads.unresolvedCount` (Task 1); `store.reviewThreads` (Task 4); `Theme.error`, `Theme.prMerged` (existing).
- Produces: `Tabler.message`, `Tabler.brandGithub`; `PRStatusIcon(status:unresolvedCount:onOpen:)` (new `unresolvedCount` param, defaults 0). `Tabler.brandGithub` is consumed by Task 6.

> No unit test. Verification = app compiles; runtime deferred to user.

- [ ] **Step 1: Add `message` + `brandGithub` glyphs, remove `eye`.** In the `Tabler` enum, delete the `eye` block (lines 867-869) and add, after `check`:

```swift
    static let message = [
        "M8 9h8",
        "M8 13h6",
        "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"]
    static let brandGithub = [
        "M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"]
```

- [ ] **Step 2: Remove the `.reviewRequired` eye case** in `PRStatusIcon.paths(_:)`. Delete this line:

```swift
        case .reviewRequired:   return Tabler.eye
```
(`.reviewRequired` now falls through to `default: return Tabler.pullRequest`; its amber `color(_:)` mapping is unchanged.)

- [ ] **Step 3: Add the badge state to `PRStatusIcon`.** Add a stored property after `let status: PRStatus`:

```swift
    var unresolvedCount: Int = 0
```

Replace the `glyph` computed view's body so the badge takes precedence:

```swift
    @ViewBuilder private var glyph: some View {
        let color = Self.color(status.kind)
        if unresolvedCount > 0 {
            // Unresolved review comments override the PR-kind glyph — a red comment icon + count.
            let label = unresolvedCount > 9 ? "9+" : "\(unresolvedCount)"
            TablerIcon(paths: Tabler.message, size: 13)
                .foregroundStyle(Theme.error)
                .overlay(alignment: .bottomTrailing) {
                    Text(label)
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(Theme.error)
                        .padding(.horizontal, 1)
                        .background(Capsule().fill(Theme.ground))
                        .offset(x: 4, y: 3)
                }
        } else if status.kind == .checksFailing {
            TablerIcon(paths: Tabler.pullRequest, size: 13)
                .foregroundStyle(color)
                .overlay(alignment: .bottomTrailing) {
                    TablerIcon(paths: Tabler.x, size: 7)
                        .foregroundStyle(color)
                        .padding(1)
                        .background(Circle().fill(Theme.ground))
                        .offset(x: 3, y: 3)
                }
        } else {
            TablerIcon(paths: Self.paths(status.kind), size: 13)
                .foregroundStyle(color)
        }
    }
```

Update the `.help(...)` to mention unresolved comments when present. Replace the existing `.help(...)` line:

```swift
        .help(unresolvedCount > 0
              ? "PR #\(status.number) · \(unresolvedCount) unresolved review comment\(unresolvedCount == 1 ? "" : "s") — click to open"
              : "PR #\(status.number) · \(Self.label(status.kind)) — click to open")
```

- [ ] **Step 4: Pass the count at the row call site** (line ~455). Replace:

```swift
                if state == .idle, let pr = store.prStatuses[tab.focusedPaneID] {
                    PRStatusIcon(status: pr) { store.openPR(forPane: tab.focusedPaneID) }
                } else {
```
with:
```swift
                if state == .idle, let pr = store.prStatuses[tab.focusedPaneID] {
                    PRStatusIcon(status: pr,
                                 unresolvedCount: PRThreads.unresolvedCount(store.reviewThreads[tab.focusedPaneID] ?? [])) {
                        store.openPR(forPane: tab.focusedPaneID)
                    }
                } else {
```

- [ ] **Step 5: Build the app, verify it compiles**

```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **` (no "cannot find 'Tabler.eye'" — confirm the removed case isn't referenced elsewhere).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/SidebarView.swift
git commit -m "feat(diff): red comment badge on idle-agent PR icon; drop reviewRequired eye

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Diff panel — render threads inline, reply/resolve/send-to-agent

**Files:**
- Modify: `Sources/DiffPanelView.swift` — `DiffReviewModel` (add UI state + `addGitHubComment`); thread the store's threads through `content` → `DiffFileView` → `DiffLineRow`; add `GitHubThreadView` + a reply composer; unanchored disclosure in `DiffFileView`.

**Interfaces:**
- Consumes: `store.reviewThreads` / `replyToThread` / `setThreadResolved` (Task 4); `GHReviewThread`/`GHReviewComment` (Task 1); `ReviewComment.githubAuthor` (Task 3); `Tabler.brandGithub`/`Tabler.message`/`Tabler.check` (Task 5); `HighlightMap.sourceLine`, `DiffReviewModel.Anchor`, `shepherdCard()`, `Theme.prMerged`/`Theme.error` (existing).

> No unit test. Verification = app compiles; runtime (fetch, reply, resolve, badge, send-to-agent) deferred to the user.

- [ ] **Step 1: Add panel UI state + the send-to-agent bridge to `DiffReviewModel`.** After `@Published var mdRaw: Set<String> = []` (line 35):

```swift
    /// Thread id whose inline reply composer is open (GitHub threads), or nil.
    @Published var replyingTo: String? = nil
    /// Resolved thread ids the user expanded (resolved threads collapse by default).
    @Published var expandedResolved: Set<String> = []
```

After `removeComment(_:)` (line ~206):

```swift
    /// Append a GitHub review comment to the outgoing batch so it ships with the same
    /// "Send to agent" button, framed for the agent via `ReviewComment.githubAuthor`.
    func addGitHubComment(file: String, line: Int, side: DiffSide, author: String, body: String) {
        comments.append(ReviewComment(id: UUID(), file: file, line: line, side: side,
                                      text: body, githubAuthor: author))
    }
```

- [ ] **Step 2: Thread the store's review threads into the content tree.** In `DiffPanelView`, replace the `ForEach(model.files ...)` in `content` (lines 417-420) so each file gets its threads (vs-base mode only):

```swift
                    ForEach(model.files, id: \.path) { file in
                        DiffFileView(file: file, model: model,
                                     hasAgent: store.diffPanelPaneID.map { store.hasLiveAgent(paneID: $0) } ?? false,
                                     threads: threadsForFile(file.path))
                    }
```

Add these helpers to `DiffPanelView` (after `reload()`):

```swift
    /// The pane's cached review threads, but only in vs-base mode (they anchor to the PR diff).
    private var paneThreads: [GHReviewThread] {
        guard model.mode == .branchVsBase, let pid = store.diffPanelPaneID else { return [] }
        return store.reviewThreads[pid] ?? []
    }
    private func threadsForFile(_ path: String) -> [GHReviewThread] {
        paneThreads.filter { $0.path == path }
    }
```

- [ ] **Step 3: Give `DiffFileView` its threads + the unanchored disclosure.** Update the struct's stored properties and body.

Add after `let hasAgent: Bool`:
```swift
    let threads: [GHReviewThread]
    @State private var showUnanchored = false
```

Add these computed helpers inside `DiffFileView` (after `collapsed`):
```swift
    /// Set of "side#line" keys for every diff line actually shown in this file.
    private var anchoredKeys: Set<String> {
        var keys: Set<String> = []
        for hunk in file.hunks {
            for line in hunk.lines {
                if let a = HighlightMap.sourceLine(for: line) { keys.insert("\(a.side)#\(a.lineNo)") }
            }
        }
        return keys
    }
    /// Threads whose line no longer maps to a shown diff line (outdated / nil line).
    private var unanchoredThreads: [GHReviewThread] {
        threads.filter { t in
            guard let line = t.line else { return true }
            return !anchoredKeys.contains("\(t.side)#\(line)")
        }
    }
```

Inside `body`, add the unanchored disclosure right after the file-header `HStack { ... }.padding(.bottom, 4)` block and before the `if collapsed` block:

```swift
            if !collapsed && !unanchoredThreads.isEmpty {
                DisclosureGroup(isExpanded: $showUnanchored) {
                    ForEach(unanchoredThreads) { thread in
                        GitHubThreadView(thread: thread, file: file.path, model: model)
                            .padding(.vertical, 4)
                    }
                } label: {
                    Text("\(unanchoredThreads.count) review comment\(unanchoredThreads.count == 1 ? "" : "s") not on the current diff")
                        .font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                }
                .padding(.bottom, 6)
            }
```

Pass the per-line threads to `DiffLineRow`. Replace the innermost `DiffLineRow(...)` call (line ~523):

```swift
                        DiffLineRow(line: line, file: file, model: model, hasAgent: hasAgent,
                                    threads: anchoredThreads)
```

And add, next to `anchoredKeys`:
```swift
    /// Threads that DO map to a visible line (rendered inline under their row).
    private var anchoredThreads: [GHReviewThread] {
        threads.filter { t in
            guard let line = t.line else { return false }
            return anchoredKeys.contains("\(t.side)#\(line)")
        }
    }
```

- [ ] **Step 4: Render anchored threads under their diff line in `DiffLineRow`.** Add a stored property after `let hasAgent: Bool`:

```swift
    let threads: [GHReviewThread]
```

Add a helper next to `commentsHere`:
```swift
    private var threadsHere: [GHReviewThread] {
        guard let a = anchor else { return [] }
        return threads.filter { $0.line == a.line && $0.side == a.side }
    }
```

In `body`, after the local-comment `ForEach(commentsHere)` block and before the composer `if`, add:
```swift
            ForEach(threadsHere) { thread in
                GitHubThreadView(thread: thread, file: file.path, model: model)
                    .padding(.leading, 52).padding(.vertical, 4)
            }
```

- [ ] **Step 5: Add `GitHubThreadView` + its reply composer.** Append to `Sources/DiffPanelView.swift` (near `CommentBubble`, at file end):

```swift
/// A GitHub PR review thread, rendered in Shepherd's idiom but unmistakably GitHub:
/// a violet left rail + octocat glyph, author/time header, stacked replies, and a
/// footer of Reply / Resolve / Send-to-agent. Resolved threads dim and collapse to
/// their root comment until expanded.
private struct GitHubThreadView: View {
    let thread: GHReviewThread
    let file: String
    @ObservedObject var model: DiffReviewModel
    @EnvironmentObject var store: AgentStore

    private var expanded: Bool { !thread.isResolved || model.expandedResolved.contains(thread.id) }
    private var visibleComments: [GHReviewComment] {
        expanded ? thread.comments : Array(thread.comments.prefix(1))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.prMerged.opacity(0.6)).frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    TablerIcon(paths: Tabler.brandGithub, size: 13).foregroundStyle(Theme.prMerged)
                    Text("Review thread").font(.ui(11, .semibold)).foregroundStyle(Theme.prMerged)
                    if thread.isResolved {
                        Text("Resolved").font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
                    }
                    Spacer()
                    if thread.isResolved {
                        Button { model.toggleExpandedResolved(thread.id) } label: {
                            Text(expanded ? "Hide" : "Show").font(.ui(10, .medium)).foregroundStyle(Theme.textDim)
                        }.buttonStyle(.plain).focusable(false)
                    }
                }
                ForEach(visibleComments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("@\(c.author.isEmpty ? "unknown" : c.author)")
                                .font(.ui(11, .semibold)).foregroundStyle(Theme.textPrimary)
                            Text(Self.relative(c.createdAt)).font(.ui(10)).foregroundStyle(Theme.textDim)
                        }
                        Text(c.body).font(.ui(12)).foregroundStyle(Theme.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if model.replyingTo == thread.id {
                    ThreadReplyComposer(thread: thread, paneID: store.diffPanelPaneID, model: model)
                } else {
                    footer
                }
            }
            .opacity(thread.isResolved && !expanded ? 0.55 : 1)
        }
        .padding(10)
        .frame(maxWidth: 460, alignment: .leading)
        .shepherdCard()
    }

    private var footer: some View {
        HStack(spacing: 14) {
            actionButton("Reply") { model.replyingTo = thread.id }
            actionButton(thread.isResolved ? "Reopen" : "Resolve") {
                if let pid = store.diffPanelPaneID {
                    store.setThreadResolved(id: thread.id, !thread.isResolved, forPane: pid)
                }
            }
            actionButton("Send to agent") {
                if let root = thread.comments.first {
                    model.addGitHubComment(file: file, line: thread.line ?? 0, side: thread.side,
                                           author: root.author, body: root.body)
                }
            }
            Spacer()
        }
    }

    private func actionButton(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.ui(11, .semibold)).foregroundStyle(Theme.prMerged)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).focusable(false)
    }

    /// Compact relative time from an ISO8601 timestamp; falls back to the raw string.
    static func relative(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let date = fmt.date(from: iso) else { return iso }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}

/// Inline reply composer for a GitHub thread — mirrors `CommentComposer`'s look, posts
/// via the store, and closes on send/cancel.
private struct ThreadReplyComposer: View {
    let thread: GHReviewThread
    let paneID: String?
    @ObservedObject var model: DiffReviewModel
    @State private var text = ""
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $text)
                .font(.ui(12)).scrollContentBackground(.hidden).focused($focused)
                .frame(height: 56)
                .overlay(alignment: .topLeading) {
                    if empty {
                        Text("Reply on GitHub…").font(.ui(12)).foregroundStyle(Theme.textDim)
                            .padding(.leading, 5).padding(.top, 1).allowsHitTesting(false)
                    }
                }
            HStack(spacing: 6) {
                Spacer()
                Button { model.replyingTo = nil } label: {
                    Text("Cancel").font(.ui(11, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 3).contentShape(Rectangle())
                }.buttonStyle(.plain).focusable(false)
                Button {
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty, let pid = paneID {
                        model.replyToThread(id: thread.id, body: t, forPane: pid)
                    }
                    model.replyingTo = nil
                } label: {
                    Text("Reply").font(.ui(11, .semibold))
                        .foregroundStyle(empty ? Theme.textDim : Theme.textPrimary)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(empty ? Color.clear : Theme.surface3)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(empty).focusable(false)
            }
        }
        .onAppear { focused = true }
    }
}
```

- [ ] **Step 6: Add the two thin `DiffReviewModel` methods the views call.** After `addGitHubComment` (added in Step 1):

```swift
    func toggleExpandedResolved(_ id: String) {
        if expandedResolved.contains(id) { expandedResolved.remove(id) } else { expandedResolved.insert(id) }
    }

    /// Post a reply via the store (needs the pane id — the panel is pane-scoped).
    func replyToThread(id: String, body: String, forPane paneID: String) {
        AgentStore.shared.replyToThread(id: id, body: body, forPane: paneID)
    }
```

> `AgentStore.shared` is the same singleton `DiffFileView.editFileButton` already uses (`AgentStore.shared.openFile(...)`). `store.setThreadResolved` is called directly from `GitHubThreadView` via its `@EnvironmentObject`.

- [ ] **Step 7: Build the app, verify it compiles**

```bash
xcodegen generate
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -25
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 8: Run the full model test suite** (nothing pure changed here, but confirm no regressions):

```bash
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
  CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests test 2>&1 | tail -15
```
Expected: all model tests pass (including `PRCommentsTests`, `DiffModelTests`).

- [ ] **Step 9: Commit**

```bash
git add spike/seam1/Sources/DiffPanelView.swift
git commit -m "feat(diff): render GitHub review threads inline with reply/resolve/send-to-agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Docs + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the diff/PR section) — one or two lines noting the feature.

- [ ] **Step 1: Update `CLAUDE.md`.** In the "PR status on idle agents" paragraph, append a sentence:

> GitHub PR **review threads** are pulled inline into the diff panel (vs-base mode) via `gh api graphql` (`GH.reviewThreads`/`replyToThread`/`setThreadResolved`, cached per-pane in `AgentStore.reviewThreads`); they render as violet octocat cards with reply / resolve / send-to-agent, distinct from local comments, and an idle agent's PR icon shows a red `message` badge with the unresolved count (`PRThreads.unresolvedCount`). Pure parse in `PRComments.swift` (`PRCommentsTests`). The `reviewRequired` eye icon was removed.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note GitHub PR review comments in the diff panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (completed while writing)

**Spec coverage:**
- Inline review comments pulled → Tasks 1, 2, 4 (model/shell/cache). ✓
- Rendered inline, visually distinct → Task 6 (`GitHubThreadView`, violet octocat). ✓
- Reply → Task 2 (`replyToThread`), 4 (store), 6 (`ThreadReplyComposer`). ✓
- Resolve/unresolve → Task 2, 4, 6 (footer toggle). ✓
- Send to agent → Task 3 (`githubAuthor` + compose), 6 (`addGitHubComment`). ✓
- Vs-base only → Task 6 (`paneThreads` gate). ✓
- Sidebar unresolved badge (red comment glyph + count, overrides) → Task 5. ✓
- Remove reviewRequired eye → Task 5. ✓
- Unanchored/outdated threads at file header → Task 6 (`unanchoredThreads` disclosure). ✓
- Fetched on PR-status triggers, store-owned (approach B) → Task 4 (cascade in `refreshPR`). ✓
- Fail-safe (no gh/PR ⇒ behaves as today) → guards in Tasks 4, 6. ✓
- Tests: parse (resolved/outdated/nil-line/multi-comment/malformed), ownerRepo, unresolvedCount → Task 1. ✓

**Type consistency:** `GHReviewThread`/`GHReviewComment` fields, `PRThreads.parse/ownerRepo/unresolvedCount`, `GH.reviewThreads/replyToThread/setThreadResolved`, `AgentStore.reviewThreads/refreshReviewThreads/replyToThread/setThreadResolved`, `PRStatusIcon(unresolvedCount:)`, `DiffReviewModel.addGitHubComment/toggleExpandedResolved/replyToThread`, `ReviewComment.githubAuthor` — all names/signatures match across tasks.

**Placeholder scan:** none — every code step is complete.
