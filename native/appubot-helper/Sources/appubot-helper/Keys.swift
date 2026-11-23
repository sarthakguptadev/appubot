import Foundation
import CoreGraphics

// macOS virtual key codes (Carbon kVK_* constants, HIToolbox/Events.h).
let keyCodes: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
    "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
    "enter": 0x24, "tab": 0x30, "space": 0x31, "backspace": 0x33, "escape": 0x35,
    "cmd": 0x37, "shift": 0x38, "capslock": 0x39, "alt": 0x3A, "ctrl": 0x3B,
    "rightcmd": 0x36, "rightshift": 0x3C, "rightalt": 0x3D, "rightctrl": 0x3E, "fn": 0x3F,
    "f17": 0x40, "kpdecimal": 0x41, "kpmultiply": 0x43, "kpplus": 0x45, "kpclear": 0x47,
    "volumeup": 0x48, "volumedown": 0x49, "mute": 0x4A,
    "kpdivide": 0x4B, "kpenter": 0x4C, "kpminus": 0x4E, "f18": 0x4F, "f19": 0x50, "kpequals": 0x51,
    "kp0": 0x52, "kp1": 0x53, "kp2": 0x54, "kp3": 0x55, "kp4": 0x56, "kp5": 0x57, "kp6": 0x58,
    "kp7": 0x59, "f20": 0x5A, "kp8": 0x5B, "kp9": 0x5C,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f3": 0x63, "f8": 0x64, "f9": 0x65, "f11": 0x67,
    "f13": 0x69, "f16": 0x6A, "f14": 0x6B, "f10": 0x6D, "f12": 0x6F, "f15": 0x71,
    "help": 0x72, "home": 0x73, "pageup": 0x74, "forwarddelete": 0x75, "f4": 0x76, "end": 0x77,
    "f2": 0x78, "pagedown": 0x79, "f1": 0x7A, "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
]

let keyAliases: [String: String] = [
    "return": "enter", "ret": "enter", "esc": "escape", "delete": "backspace", "bksp": "backspace",
    "del": "forwarddelete", "fwddelete": "forwarddelete", "deleteforward": "forwarddelete",
    "spacebar": "space", "command": "cmd", "super": "cmd", "meta": "cmd", "win": "cmd", "windows": "cmd",
    "option": "alt", "opt": "alt", "control": "ctrl", "function": "fn", "caps": "capslock",
    "arrowup": "up", "uparrow": "up", "arrowdown": "down", "downarrow": "down",
    "arrowleft": "left", "leftarrow": "left", "arrowright": "right", "rightarrow": "right",
    "pgup": "pageup", "prior": "pageup", "pgdn": "pagedown", "pgdown": "pagedown", "next": "pagedown",
    "keypadenter": "kpenter", "minus": "-", "equal": "=", "equals": "=", "comma": ",", "period": ".",
    "dot": ".", "slash": "/", "backslash": "\\", "semicolon": ";", "quote": "'", "apostrophe": "'",
    "grave": "`", "backtick": "`", "bracketleft": "[", "leftbracket": "[", "bracketright": "]",
    "rightbracket": "]", "plus": "+", "lcmd": "cmd", "lshift": "shift", "lalt": "alt", "lctrl": "ctrl",
    "rcmd": "rightcmd", "rshift": "rightshift", "ralt": "rightalt", "rctrl": "rightctrl",
    "rightoption": "rightalt", "rightcontrol": "rightctrl", "rightcommand": "rightcmd",
    "shiftl": "shift", "shiftr": "rightshift", "controll": "ctrl", "controlr": "rightctrl",
    "altl": "alt", "altr": "rightalt", "superl": "cmd", "superr": "rightcmd", "metal": "cmd",
    "kpreturn": "kpenter", "insert": "help", "volume_up": "volumeup", "volume_down": "volumedown",
]

/// Shifted US-layout characters -> base key.
let shiftedChars: [Character: String] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]

/// Modifier name -> (flag, keycode used when pressing it).
let modifierTable: [String: (CGEventFlags, CGKeyCode)] = [
    "cmd": (.maskCommand, 0x37), "shift": (.maskShift, 0x38), "alt": (.maskAlternate, 0x3A),
    "ctrl": (.maskControl, 0x3B), "fn": (.maskSecondaryFn, 0x3F),
    "rightcmd": (.maskCommand, 0x36), "rightshift": (.maskShift, 0x3C),
    "rightalt": (.maskAlternate, 0x3D), "rightctrl": (.maskControl, 0x3E),
    "capslock": (.maskAlphaShift, 0x39),
]

let modifierKeyCodes: Set<CGKeyCode> = [0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F]

/// Keys that carry the Fn / numeric-pad flags when produced by real hardware.
let arrowKeyCodes: Set<CGKeyCode> = [0x7B, 0x7C, 0x7D, 0x7E]
let fnFlagKeyCodes: Set<CGKeyCode> = [0x72, 0x73, 0x74, 0x75, 0x77, 0x79,
                                      0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
                                      0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A]

/// Canonical name for a multi-character key name ("Page_Up" -> "pageup", "Return" -> "enter").
func canonicalKeyName(_ raw: String) -> String {
    if raw.count == 1 { return raw }
    var s = raw.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: " ", with: "")
    if s.count > 1, s.hasSuffix("-") == false { s = s.replacingOccurrences(of: "-", with: "") }
    return keyAliases[s] ?? s
}

struct ResolvedKey {
    let code: CGKeyCode
    let extraFlags: CGEventFlags
    let name: String
}

/// Resolves a single key name (not a combo). Returns nil if unknown.
func resolveKey(_ raw: String) -> ResolvedKey? {
    if raw.count == 1, let ch = raw.first {
        let lower = String(ch).lowercased()
        if ch.isLetter, String(ch) != lower, let code = keyCodes[lower] {
            return ResolvedKey(code: code, extraFlags: .maskShift, name: lower)
        }
        if let code = keyCodes[lower] { return ResolvedKey(code: code, extraFlags: [], name: lower) }
        if let base = shiftedChars[ch], let code = keyCodes[base] {
            return ResolvedKey(code: code, extraFlags: .maskShift, name: base)
        }
        if ch == " " { return ResolvedKey(code: 0x31, extraFlags: [], name: "space") }
        if ch == "\n" || ch == "\r" { return ResolvedKey(code: 0x24, extraFlags: [], name: "enter") }
        if ch == "\t" { return ResolvedKey(code: 0x30, extraFlags: [], name: "tab") }
        return nil
    }
    let name = canonicalKeyName(raw)
    if name == "+" { return ResolvedKey(code: 0x18, extraFlags: .maskShift, name: "=") }
    if let code = keyCodes[name] { return ResolvedKey(code: code, extraFlags: [], name: name) }
    return nil
}

/// Flags for a modifier name, or nil if not a modifier.
func modifierFlag(_ raw: String) -> CGEventFlags? {
    let n = canonicalKeyName(raw.lowercased())
    return modifierTable[n]?.0
}

func parseModifiers(_ names: [String]) throws -> CGEventFlags {
    var f: CGEventFlags = []
    for n in names {
        guard let flag = modifierFlag(n) else {
            throw HelperError.invalid("unknown modifier '\(n)'; use cmd, shift, alt/option, ctrl/control, fn")
        }
        f.insert(flag)
    }
    return f
}

func modifierNames(_ flags: CGEventFlags) -> [String] {
    var out: [String] = []
    if flags.contains(.maskCommand) { out.append("cmd") }
    if flags.contains(.maskShift) { out.append("shift") }
    if flags.contains(.maskAlternate) { out.append("alt") }
    if flags.contains(.maskControl) { out.append("ctrl") }
    if flags.contains(.maskSecondaryFn) { out.append("fn") }
    return out
}

/// Splits "ctrl+shift+t" into (["ctrl","shift"], "t"). Handles "+" and "cmd++".
func splitCombo(_ s: String) -> (mods: [String], key: String) {
    let t = s.trimmingCharacters(in: .whitespaces)
    if t == "+" { return ([], "+") }
    if t.hasSuffix("++") {
        let rest = String(t.dropLast(2))
        return (rest.split(separator: "+").map(String.init), "+")
    }
    let parts = t.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard let last = parts.last else { return ([], t) }
    return (Array(parts.dropLast()), last)
}

/// Reverse map used by the watcher (keycode -> canonical name).
let keyNamesByCode: [CGKeyCode: String] = {
    var m: [CGKeyCode: String] = [:]
    for (name, code) in keyCodes where m[code] == nil || name.count < m[code]!.count { m[code] = name }
    return m
}()
