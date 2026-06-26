// swift-tools-version:5.9
import PackageDescription

// Reference scaffolding for the Shepherd chrome (seam 1). It typechecks and the
// GhosttySurfaceView is a stub, so it builds without GhosttyKit. The real path is
// an Xcode macOS app target — see SEAM1.md. This package exists so the skeleton
// forms a coherent module (and so editors resolve the cross-file types).
let package = Package(
    name: "Shepherd",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Shepherd")
    ]
)
