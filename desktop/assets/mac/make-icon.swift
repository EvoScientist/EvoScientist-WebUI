// Draws the macOS app icon: the robot on a rounded dark plate, on the grid
// macOS icons use (a 1024 px canvas with an 824 px plate). macOS 26 puts an
// icon without a plate of its own on a grey one.
// Usage: swift make-icon.swift <robot.png> <out.png>   (see make-icon.sh)
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let robot = NSImage(contentsOfFile: args[1]) else {
  FileHandle.standardError.write("usage: make-icon.swift <robot.png> <out.png>\n".data(using: .utf8)!)
  exit(2)
}

let canvas = 1024
let plate = NSRect(x: 100, y: 100, width: 824, height: 824)
let radius: CGFloat = 185
/// The robot's side on the canvas; its picture has empty margins of its own.
let robotSide: CGFloat = 720

func color(_ hex: Int) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: 1)
}

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: canvas, height: canvas)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .high

let shape = NSBezierPath(roundedRect: plate, xRadius: radius, yRadius: radius)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor(white: 0, alpha: 0.3)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 24
shadow.set()
color(0x0F2A3D).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()
// Top to bottom: #17405C to #07141F.
NSGradient(starting: color(0x07141F), ending: color(0x17405C))!.draw(in: shape, angle: 90)

let side = robotSide
robot.draw(
  in: NSRect(x: (CGFloat(canvas) - side) / 2, y: (CGFloat(canvas) - side) / 2 - 6, width: side, height: side),
  from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
