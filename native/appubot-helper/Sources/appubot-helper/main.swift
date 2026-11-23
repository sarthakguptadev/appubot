import Foundation
import AppKit

// appubot-helper: computer-use helper for AppuBot.
//   stdin/stdout NDJSON mode:  appubot-helper            (or: appubot-helper --stdio)
//   one-shot debug mode:       appubot-helper <cmd> '<params json>'

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IONBF, 0)

let commandQueue = DispatchQueue(label: "appubot.commands", qos: .userInitiated)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
_ = systemWideElement  // sets the global AX messaging timeout

let usage = """
appubot-helper \(helperVersion)
Usage:
  appubot-helper                 read NDJSON requests from stdin, write responses to stdout
  appubot-helper <cmd> [json]    run a single command and print its response
Commands: \(commandTable.keys.sorted().joined(separator: ", "))
"""

let argv = CommandLine.arguments
if argv.count >= 2 && argv[1] != "--stdio" {
    let cmd = argv[1]
    if cmd == "-h" || cmd == "--help" || cmd == "help" {
        fputs(usage + "\n", stderr)
        exit(0)
    }
    if cmd == "--version" || cmd == "-v" {
        fputs(helperVersion + "\n", stderr)
        exit(0)
    }
    let paramsJSON = argv.count >= 3 ? argv[2] : "{}"
    commandQueue.async {
        let line: String
        if let data = paramsJSON.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
            let req: [String: Any] = ["id": 1, "cmd": cmd, "params": obj]
            let d = (try? JSONSerialization.data(withJSONObject: req, options: [])) ?? Data()
            line = String(decoding: d, as: UTF8.self)
        } else {
            Output.shared.send(errorResponse(1, "invalid_params", "params argument is not valid JSON: \(paramsJSON)"))
            exit(2)
        }
        guard let (resp, _) = handleLine(line) else { exit(2) }
        Output.shared.send(resp)
        let ok = (resp["ok"] as? Bool) ?? false
        if cmd == "watch_start" && ok {
            logErr("watching input events; press Ctrl-C to stop")
            return
        }
        exit(ok ? 0 : 1)
    }
} else {
    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            commandQueue.async {
                autoreleasepool {
                    guard let (resp, cmd) = handleLine(line) else { return }
                    Output.shared.send(resp)
                    if cmd == "quit" && (resp["ok"] as? Bool) == true {
                        _ = Watcher.shared.isRunning ? Watcher.shared.stop() : [:]
                        exit(0)
                    }
                }
            }
        }
        // stdin closed: parent went away. Finish pending work and exit.
        commandQueue.sync {}
        exit(0)
    }
    reader.stackSize = 4 << 20
    reader.name = "stdin-reader"
    reader.start()
    logErr("ready (v\(helperVersion), pid \(getpid()))")
}

app.run()
