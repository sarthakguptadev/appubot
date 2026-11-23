// The dev build's Dock icon (make-icon.mjs): an edge-to-edge icon image put on macOS's icon grid, the 824px tile
// centred in a transparent 1024px canvas, as every other app's icon sits in the Dock.
// Usage: swift scripts/pad-icon.swift <in.png> <out.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let src = NSImage(contentsOfFile: args[1])?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: pad-icon.swift <in.png> <out.png>\n".data(using: .utf8)!)
  exit(1)
}
let canvas = 1024, tile = 824, inset = (canvas - tile) / 2
guard let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.interpolationQuality = .high
ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))
ctx.draw(src, in: CGRect(x: inset, y: inset, width: tile, height: tile))
guard let out = ctx.makeImage(), let png = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
