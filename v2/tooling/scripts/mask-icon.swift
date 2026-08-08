// Turn a full-bleed square PNG into a macOS app icon.
//
//   swift tooling/scripts/mask-icon.swift <src.png> <out.png>
//
// macOS does NOT round an app icon for you: every native icon ships already
// drawn inside Apple's squircle with transparent padding around it, and art
// that fills its canvas renders as a square tile in the Dock, in Raycast and
// everywhere else. Measured — that is exactly what Shep's first icon did.
//
// The two numbers are Apple's: the art occupies 80% of the canvas (10% padding
// per edge), and the corner radius is 22.37% of the art's side.
import AppKit
import Foundation

// macOS app-icon geometry: the art occupies ~80% of the canvas inside a
// squircle, with the rest transparent padding. A full-bleed square renders as a
// square tile in every launcher — which is what Raycast showed.
let args = CommandLine.arguments
let src = args[1], dst = args[2]
let side: CGFloat = 1024
let inset: CGFloat = side * 0.10          // ~10% padding on each edge
let artSide = side - inset * 2
let radius = artSide * 0.2237             // Apple's continuous-corner ratio

guard let input = NSImage(contentsOfFile: src) else { exit(1) }
let out = NSImage(size: NSSize(width: side, height: side))
out.lockFocus()
NSColor.clear.set()
NSRect(x: 0, y: 0, width: side, height: side).fill()
let rect = NSRect(x: inset, y: inset, width: artSide, height: artSide)
let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
path.addClip()
input.draw(in: rect, from: .zero, operation: .copy, fraction: 1.0)
out.unlockFocus()

guard let tiff = out.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: dst))
