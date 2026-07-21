import XCTest
@testable import Shepherd

final class ShortcutCatalogTests: XCTestCase {

    func testEveryCommandHasTitleAndDisplay() {
        for cmd in ShortcutCatalog.all {
            XCTAssertFalse(cmd.title.isEmpty, "\(cmd.id) has an empty title")
            XCTAssertFalse(cmd.display.isEmpty, "\(cmd.id) has an empty display")
        }
    }

    func testNoDuplicateDisplayGlyphs() {
        let displays = ShortcutCatalog.all.map(\.display)
        XCTAssertEqual(Set(displays).count, displays.count, "duplicate keycap glyphs in the catalog")
    }

    func testNoDuplicateIDs() {
        let ids = ShortcutCatalog.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate ShortcutIDs in the catalog")
    }

    // Every ShortcutID appears exactly once — guards against a menu/cheatsheet row
    // silently missing after the enum grows.
    func testCatalogCoversEveryID() {
        XCTAssertEqual(Set(ShortcutCatalog.all.map(\.id)), Set(ShortcutID.allCases))
    }

    func testMenuCommandsAllHaveKeys() {
        for cmd in ShortcutCatalog.menuCommands {
            XCTAssertNotNil(cmd.key, "\(cmd.id) is a menu command but has no key")
        }
    }

    func testEveryCategoryHasAtLeastOneCommand() {
        for cat in ShortcutCategory.allCases {
            XCTAssertFalse(ShortcutCatalog.commands(in: cat).isEmpty, "\(cat) has no commands")
        }
    }
}
