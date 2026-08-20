#!/usr/bin/env swift
import AppKit
import Foundation

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

func squircle(in rect: CGRect) -> CGPath {
  let path = CGMutablePath()
  let r = rect.width * 0.223
  path.addRoundedRect(in: rect, cornerWidth: r, cornerHeight: r)
  return path
}

func drawAppIcon(ctx: CGContext, size: CGFloat) {
  let pad = size * 0.07
  let board = CGRect(x: pad, y: pad, width: size - pad * 2, height: size - pad * 2)

  ctx.saveGState()
  ctx.addPath(squircle(in: board))
  ctx.clip()

  let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    colors: [
      srgb(0.36, 0.52, 1.00),
      srgb(0.11, 0.13, 0.28),
    ] as CFArray,
    locations: [0, 1]
  )!
  ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: board.minX, y: board.maxY),
    end: CGPoint(x: board.maxX, y: board.minY),
    options: []
  )

  let shine = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    colors: [
      srgb(1, 1, 1, 0.18),
      srgb(1, 1, 1, 0),
    ] as CFArray,
    locations: [0, 1]
  )!
  ctx.drawLinearGradient(
    shine,
    start: CGPoint(x: board.midX, y: board.maxY),
    end: CGPoint(x: board.midX, y: board.midY),
    options: []
  )
  ctx.restoreGState()

  // Overlay-card bubble
  let bubbleW = board.width * 0.56
  let bubbleH = board.height * 0.46
  let bubble = CGRect(
    x: board.midX - bubbleW / 2,
    y: board.midY - bubbleH / 2 + board.height * 0.04,
    width: bubbleW,
    height: bubbleH
  )
  let bubbleRadius = bubble.width * 0.22
  ctx.setFillColor(srgb(1, 1, 1, 0.16))
  ctx.addPath(CGPath(roundedRect: bubble, cornerWidth: bubbleRadius, cornerHeight: bubbleRadius, transform: nil))
  ctx.fillPath()

  // Small tail so it reads as a reply, not a window
  let tailSize = bubble.width * 0.16
  let tail = CGMutablePath()
  let tx = bubble.minX + bubble.width * 0.22
  tail.move(to: CGPoint(x: tx, y: bubble.minY + 1))
  tail.addLine(to: CGPoint(x: tx + tailSize, y: bubble.minY + 1))
  tail.addLine(to: CGPoint(x: tx + tailSize * 0.15, y: bubble.minY - tailSize * 0.72))
  tail.closeSubpath()
  ctx.addPath(tail)
  ctx.setFillColor(srgb(1, 1, 1, 0.16))
  ctx.fillPath()

  drawWaveform(
    ctx: ctx,
    in: bubble.insetBy(dx: bubble.width * 0.22, dy: bubble.height * 0.22),
    color: srgb(0.957, 0.957, 0.969)
  )
}

func drawWaveform(ctx: CGContext, in rect: CGRect, color: CGColor) {
  let heights: [CGFloat] = [0.42, 1.0, 0.68]
  let gaps: CGFloat = 0.32
  let n = CGFloat(heights.count)
  let barW = rect.width / (n + gaps * (n - 1))
  let gap = barW * gaps
  ctx.setFillColor(color)
  for (i, h) in heights.enumerated() {
    let barH = max(rect.height * h, barW)
    let x = rect.minX + CGFloat(i) * (barW + gap)
    let y = rect.midY - barH / 2
    let bar = CGRect(x: x, y: y, width: barW, height: barH)
    let r = barW / 2
    ctx.addPath(CGPath(roundedRect: bar, cornerWidth: r, cornerHeight: r, transform: nil))
    ctx.fillPath()
  }
}

func drawTray(ctx: CGContext, size: CGFloat) {
  let inset = size * 0.14
  let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  drawWaveform(ctx: ctx, in: rect, color: srgb(0, 0, 0))
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
