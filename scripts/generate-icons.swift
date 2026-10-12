#!/usr/bin/env swift
import AppKit
import Foundation
import ImageIO

let root = URL(fileURLWithPath: CommandLine.arguments[0])
  .resolvingSymlinksInPath()
  .deletingLastPathComponent()
  .deletingLastPathComponent()

func srgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

func render(size: Int, draw: (CGContext, CGFloat) -> Void) -> Data {
  let side = size
  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(
    data: nil,
    width: side,
    height: side,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  ctx.setAllowsAntialiasing(true)
  ctx.interpolationQuality = .high
  ctx.clear(CGRect(x: 0, y: 0, width: side, height: side))
  draw(ctx, CGFloat(side))
  let image = ctx.makeImage()!
  let rep = NSBitmapImageRep(cgImage: image)
  return rep.representation(using: .png, properties: [:])!
}

// Keep the approved rebrand as the source for every macOS icon size.
// ImageIO preserves its transparency; CGContext supplies high-quality downsampling.
let iconSourceURL = root.appendingPathComponent("build/branding/meeting-copilot-source.png")
guard let iconSource = CGImageSourceCreateWithURL(iconSourceURL as CFURL, nil),
      let brandIcon = CGImageSourceCreateImageAtIndex(iconSource, 0, nil) else {
  fputs("Missing or invalid brand source: \(iconSourceURL.path)\n", stderr)
  exit(1)
}

func drawAppIcon(ctx: CGContext, size: CGFloat) {
  ctx.draw(brandIcon, in: CGRect(x: 0, y: 0, width: size, height: size))
}

// A compact monochrome silhouette of the ribbon M, rather than the old
// waveform. Template alpha lets macOS supply the correct light/dark tint.
func drawTray(ctx: CGContext, size: CGFloat) {
  ctx.saveGState()
  ctx.translateBy(x: size * 0.08, y: size * 0.92)
  ctx.scaleBy(x: size * 0.84, y: -size * 0.84)
  let ribbon = CGMutablePath()
  ribbon.move(to: CGPoint(x: 0.08, y: 0.82))
  ribbon.addLine(to: CGPoint(x: 0.08, y: 0.24))
  ribbon.addCurve(to: CGPoint(x: 0.22, y: 0.16), control1: CGPoint(x: 0.08, y: 0.12), control2: CGPoint(x: 0.13, y: 0.10))
  ribbon.addCurve(to: CGPoint(x: 0.50, y: 0.43), control1: CGPoint(x: 0.30, y: 0.21), control2: CGPoint(x: 0.42, y: 0.35))
  ribbon.addCurve(to: CGPoint(x: 0.78, y: 0.16), control1: CGPoint(x: 0.58, y: 0.35), control2: CGPoint(x: 0.70, y: 0.21))
  ribbon.addCurve(to: CGPoint(x: 0.92, y: 0.24), control1: CGPoint(x: 0.87, y: 0.10), control2: CGPoint(x: 0.92, y: 0.12))
  ribbon.addLine(to: CGPoint(x: 0.92, y: 0.82))
  ribbon.addCurve(to: CGPoint(x: 0.72, y: 0.72), control1: CGPoint(x: 0.92, y: 0.95), control2: CGPoint(x: 0.72, y: 0.91))
  ribbon.addLine(to: CGPoint(x: 0.72, y: 0.44))
  ribbon.addLine(to: CGPoint(x: 0.57, y: 0.61))
  ribbon.addCurve(to: CGPoint(x: 0.43, y: 0.61), control1: CGPoint(x: 0.52, y: 0.67), control2: CGPoint(x: 0.48, y: 0.67))
  ribbon.addLine(to: CGPoint(x: 0.28, y: 0.44))
  ribbon.addLine(to: CGPoint(x: 0.28, y: 0.72))
  ribbon.addCurve(to: CGPoint(x: 0.08, y: 0.82), control1: CGPoint(x: 0.28, y: 0.91), control2: CGPoint(x: 0.08, y: 0.95))
  ribbon.closeSubpath()
  ctx.addPath(ribbon)
  ctx.setFillColor(srgb(0, 0, 0))
  ctx.fillPath()
  ctx.restoreGState()
}

func write(_ data: Data, _ url: URL) throws {
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  try data.write(to: url)
}

let assets = root.appendingPathComponent("src/assets")
let build = root.appendingPathComponent("build")
let iconset = build.appendingPathComponent("icon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)

let appPng = render(size: 1024, draw: drawAppIcon)
try write(appPng, build.appendingPathComponent("icon.png"))

let iconsetSizes: [(name: String, px: Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024),
]
for item in iconsetSizes {
  let data = render(size: item.px, draw: drawAppIcon)
  try write(data, iconset.appendingPathComponent(item.name))
}

try write(render(size: 18, draw: drawTray), assets.appendingPathComponent("trayTemplate.png"))
try write(render(size: 36, draw: drawTray), assets.appendingPathComponent("trayTemplate@2x.png"))
try write(render(size: 54, draw: drawTray), assets.appendingPathComponent("trayTemplate@3x.png"))

let icns = build.appendingPathComponent("icon.icns")
let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
proc.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try proc.run()
proc.waitUntilExit()
if proc.terminationStatus != 0 {
  fputs("iconutil failed — tray templates were still written\n", stderr)
  exit(1)
}

try? FileManager.default.removeItem(at: iconset)
print("Wrote \(icns.path) and tray templates")
