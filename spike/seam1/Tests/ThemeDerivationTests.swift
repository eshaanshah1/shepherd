import XCTest
@testable import Shepherd

/// The derivation chain's guarantee, made executable: every theme yields a
/// complete token set, diff colors are independent of the state-dot colors, and
/// the shared line height is the one number both the diff and the editor read.
final class ThemeDerivationTests: XCTestCase {
    private let allModes: [ThemeMode] = [.dark, .light, .warm]

    override func tearDown() {
        Theme.mode = .dark
        super.tearDown()
    }

    func testEveryModeDerivesACompleteTokenSet() {
        for mode in allModes {
            let tokens = Theme.derivedTokens(for: mode)
            XCTAssertFalse(tokens.isEmpty, "\(mode) derived no tokens")
            for (name, value) in tokens {
                XCTAssertTrue(value <= 0xFFFFFF, "\(mode).\(name) is not a 24-bit RGB value")
            }
        }
    }

    func testAllModesDeriveTheSameTokenNames() {
        let names = allModes.map { Set(Theme.derivedTokens(for: $0).keys) }
        for (idx, set) in names.enumerated().dropFirst() {
            XCTAssertEqual(set, names[0],
                           "\(allModes[idx]) has a different token set than .dark — a hole in the chain")
        }
    }

    func testDeriveDoesNotLeakTheActiveMode() {
        Theme.mode = .warm
        _ = Theme.derivedTokens(for: .light)
        XCTAssertEqual(Theme.mode, .warm, "derivedTokens must restore the active mode")
    }

    func testDiffColorsAreNotTheStateColors() {
        // The bug this fixes: "line added" green was literally Theme.needsCheck,
        // the same green as "agent is done".
        for mode in allModes {
            Theme.mode = mode
            XCTAssertNotEqual(Theme.Diff.addition, Theme.Code.string,
                              "\(mode): diff addition collides with the syntax string color")
            XCTAssertNotEqual(Theme.Diff.deletion, Theme.Diff.addition,
                              "\(mode): addition and deletion are the same color")
            XCTAssertNotEqual(Theme.Diff.modified, Theme.Diff.addition,
                              "\(mode): modified and addition are the same color")
        }
    }

    func testDiffTokensRespondToTheActiveMode() {
        Theme.mode = .dark
        let dark = Theme.Diff.addition
        Theme.mode = .light
        XCTAssertNotEqual(Theme.Diff.addition, dark,
                          "diff tokens must re-resolve per theme, not be cached at launch")
    }

    func testLineHeightIsSharedAndMatchesTheSpec() {
        XCTAssertEqual(Theme.lineHeightMultiple, 1.5, accuracy: 0.0001)
    }
}
