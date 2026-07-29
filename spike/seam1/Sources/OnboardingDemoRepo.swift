import Foundation

struct DemoRepoPaths: Equatable {
    let root: String
    let origin: String
    let clone: String
    let repoName: String

    /// `~/.shepherd/demo` (or `~/.shepherd/dev/demo` on a dev build).
    static func standard() -> DemoRepoPaths {
        let root = AppMode.supportPath("demo")
        return DemoRepoPaths(root: root,
                             origin: (root as NSString).appendingPathComponent("origin.git"),
                             clone: (root as NSString).appendingPathComponent("tour-repo"),
                             repoName: "tour-repo")
    }
}

struct DemoRepoError: Error, Equatable {
    let command: String
    let message: String
}

/// The throwaway git repository the tour operates in: a bare "remote" plus a working
/// clone, generated locally so it is offline and identical for every user.
enum OnboardingDemoRepo {

    static let baseBranch = "main"
    static let branch = "feature/greeting"

    /// Rewords the README's first line, as does the commit the conflict step makes in
    /// the worktree — so merging this branch there conflicts on one small region.
    static let conflictBranch = "feature/rename"

    // Identity and settings ride every invocation rather than `git config`, so the
    // sandbox neither depends on nor inherits the user's global git setup — an unset
    // user.name fails the build, and GPG signing blocks it on a passphrase prompt.
    private static let cfg = [
        "-c", "user.name=Shepherd Tour",
        "-c", "user.email=tour@shepherd.local",
        "-c", "commit.gpgsign=false",
        "-c", "init.defaultBranch=main",
        "-c", "advice.detachedHead=false",
    ]

    // MARK: - Contents

    private static let readme = """
    # tour-repo

    A tiny sample project for trying out Shepherd's review tools.

    ## Usage

        python greeter.py
    """

    private static let greeterV1 = """
    def greet(name):
        return "Hello, " + name


    def farewell(name):
        return "Bye, " + name


    def main():
        print(greet("world"))
        print(farewell("world"))


    if __name__ == "__main__":
        main()
    """

    private static let greeterV2 = greeterV1.replacingOccurrences(
        of: #"return "Bye, " + name"#,
        with: #"return "Goodbye, " + name"#)

    private static let readmeRenamed = readme.replacingOccurrences(
        of: "# tour-repo", with: "# Tour Repository")

    private static let notesV1 = """
    # TODO

    - [x] greet someone by name
    - [ ] read the name from argv
    - [ ] add a test for farewell
    """

    private static let greeterOnBranch = greeterV2 + """


    def shout(name):
        return greet(name).upper()
    """

    private static let notesOnBranch = notesV1 + "\n- [ ] shout() for emphasis\n"

    // Two edits far enough apart that git keeps them as separate hunks, one of which
    // only removes a line — so the workbench has a deletion band to draw.
    private static let greeterStaged = greeterOnBranch
        .replacingOccurrences(of: #"return "Hello, " + name"#,
                              with: #"return f"Hello, {name}!""#)
        .replacingOccurrences(of: "    print(farewell(\"world\"))\n", with: "")

    private static let notesUnstaged = notesOnBranch + "- [ ] handle an empty name\n"

    private static let scratch = """
    from greeter import greet

    print(greet("Ada"))
    """

    // MARK: - Build

    static func build(at p: DemoRepoPaths) -> Result<Void, DemoRepoError> {
        removeSandbox(at: p)
        do {
            try FileManager.default.createDirectory(atPath: p.clone, withIntermediateDirectories: true)

            try git(["init"], in: p.clone)
            try commit(files: ["README.md": readme], "Add a README", p)
            try commit(files: ["greeter.py": greeterV1], "Add the greeter", p)
            try commit(files: ["TODO.md": notesV1, "greeter.py": greeterV2],
                       "Add notes; say goodbye properly", p)

            try git(["checkout", "-b", conflictBranch, baseBranch], in: p.clone)
            try commit(files: ["README.md": readmeRenamed], "Reword the README", p)

            try git(["checkout", "-b", branch, baseBranch], in: p.clone)
            try commit(files: ["greeter.py": greeterOnBranch], "Add shout()", p)
            try commit(files: ["TODO.md": notesOnBranch], "Note the new helper", p)

            try git(["init", "--bare", p.origin], in: p.root)
            try git(["remote", "add", "origin", p.origin], in: p.clone)
            try git(["push", "origin", baseBranch, branch, conflictBranch], in: p.clone)
            try git(["remote", "set-head", "origin", baseBranch], in: p.clone)

            try write(greeterStaged, "greeter.py", p)
            try git(["add", "greeter.py"], in: p.clone)
            try write(notesUnstaged, "TODO.md", p)
            try write(scratch, "scratch.py", p)

            return .success(())
        } catch let e as DemoRepoError {
            return .failure(e)
        } catch {
            return .failure(DemoRepoError(command: "filesystem", message: error.localizedDescription))
        }
    }

    // MARK: - Teardown

    /// Idempotent. Removes the worktree the tour created (which lives *outside* the
    /// sandbox, so `rm -rf` on the sandbox alone leaves a stale registration), then
    /// the sandbox itself.
    static func teardown(at p: DemoRepoPaths, worktreeBase: String) {
        if FileManager.default.fileExists(atPath: p.clone) {
            for dir in linkedWorktrees(in: p.clone) {
                _ = Git.run(cfg + ["worktree", "remove", "--force", dir], in: p.clone)
            }
            _ = Git.run(cfg + ["worktree", "prune"], in: p.clone)
        }
        try? FileManager.default.removeItem(
            atPath: (worktreeBase as NSString).appendingPathComponent(p.repoName))
        removeSandbox(at: p)
    }

    private static func removeSandbox(at p: DemoRepoPaths) {
        try? FileManager.default.removeItem(atPath: p.root)
    }

    /// Linked worktrees only — the main checkout is also a `worktree` record and must
    /// not be handed to `worktree remove`. Paths are compared resolved, since git
    /// reports `/private/var/…` where the caller may hold `/var/…`.
    private static func linkedWorktrees(in clone: String) -> [String] {
        let main = resolved(clone)
        let out = Git.run(cfg + ["worktree", "list", "--porcelain"], in: clone).out
        return out.split(separator: "\n")
            .filter { $0.hasPrefix("worktree ") }
            .map { String($0.dropFirst("worktree ".count)) }
            .filter { resolved($0) != main }
    }

    private static func resolved(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    // MARK: - Shell

    private static func git(_ args: [String], in dir: String) throws {
        let r = Git.run(cfg + args, in: dir)
        guard r.code == 0 else {
            throw DemoRepoError(command: "git " + args.joined(separator: " "),
                                message: r.err.isEmpty ? r.out : r.err)
        }
    }

    private static func write(_ contents: String, _ name: String, _ p: DemoRepoPaths) throws {
        try contents.write(toFile: (p.clone as NSString).appendingPathComponent(name),
                           atomically: true, encoding: .utf8)
    }

    private static func commit(files: [String: String], _ message: String,
                               _ p: DemoRepoPaths) throws {
        for (name, contents) in files.sorted(by: { $0.key < $1.key }) {
            try write(contents, name, p)
            try git(["add", name], in: p.clone)
        }
        try git(["commit", "-m", message], in: p.clone)
    }
}
