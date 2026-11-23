import Foundation

typealias CommandHandler = (Params) throws -> Any

let commandTable: [String: CommandHandler] = [
    "ping": cmdPing,
    "permissions": cmdPermissions,
    "request_permissions": cmdRequestPermissions,
    "open_settings": cmdOpenSettings,
    "displays": cmdDisplays,
    "screen_size": cmdScreenSize,
    "screenshot": cmdScreenshot,
    "window_screenshot": cmdWindowScreenshot,
    "window_stream_frame": cmdWindowStreamFrame,
    "window_stream_stop": cmdWindowStreamStop,
    "display_stream_frame": cmdDisplayStreamFrame,
    "display_stream_stop": cmdDisplayStreamStop,
    "display_video_start": cmdDisplayVideoStart,
    "display_video_config": cmdDisplayVideoConfig,
    "display_video_key": cmdDisplayVideoKey,
    "display_video_stop": cmdDisplayVideoStop,
    "cursor_position": cmdCursorPosition,
    "input_idle": cmdInputIdle,
    "mouse_move": cmdMouseMove,
    "click": cmdClick,
    "mouse_down": cmdMouseDown,
    "mouse_up": cmdMouseUp,
    "drag": cmdDrag,
    "scroll": cmdScroll,
    "type_text": cmdTypeText,
    "key": cmdKey,
    "hotkey": cmdHotkey,
    "running_apps": cmdRunningApps,
    "open_app": cmdOpenApp,
    "activate_app": cmdActivateApp,
    "quit_app": cmdQuitApp,
    "open_url": cmdOpenURL,
    "open_path": cmdOpenPath,
    "list_windows": cmdListWindows,
    "focus_window": cmdFocusWindow,
    "frontmost_app": cmdFrontmostApp,
    "focused_window": cmdFocusedWindow,
    "ax_tree": cmdAXTree,
    "ax_press": cmdAXPress,
    "ax_set_value": cmdAXSetValue,
    "ax_element_at": cmdAXElementAt,
    "ax_focused_element": cmdAXFocusedElement,
    "clipboard_get": cmdClipboardGet,
    "clipboard_set": cmdClipboardSet,
    "wait": cmdWait,
    "watch_start": cmdWatchStart,
    "watch_stop": cmdWatchStop,
    "notify": cmdNotify,
    "quit": { _ in ["bye": true] },
]

func errorResponse(_ id: Any?, _ code: String, _ message: String) -> [String: Any] {
    ["id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]]
}

func runCommand(id: Any?, cmd: String, params: [String: Any]) -> [String: Any] {
    guard let handler = commandTable[cmd] else {
        return errorResponse(id, "unknown_command", "unknown command '\(cmd)'. Known: \(commandTable.keys.sorted().joined(separator: ", "))")
    }
    do {
        let result = try handler(Params(params))
        return ["id": id ?? NSNull(), "ok": true, "result": result]
    } catch let e as HelperError {
        return errorResponse(id, e.code, e.message)
    } catch {
        return errorResponse(id, "internal_error", String(describing: error))
    }
}

/// Parses one protocol line and returns the response (nil for blank lines).
func handleLine(_ line: String) -> (response: [String: Any], cmd: String?)? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard let data = trimmed.data(using: .utf8),
          let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
        return (errorResponse(nil, "parse_error", "request is not valid JSON"), nil)
    }
    guard let obj = any as? [String: Any] else {
        return (errorResponse(nil, "invalid_request", "request must be a JSON object {id, cmd, params}"), nil)
    }
    var id = obj["id"]
    if let i = id, !(i is String), !(i is NSNumber), !(i is NSNull) { id = NSNull() }
    guard let cmd = obj["cmd"] as? String, !cmd.isEmpty else {
        return (errorResponse(id, "invalid_request", "missing string field 'cmd'"), nil)
    }
    var params: [String: Any] = [:]
    if let pv = obj["params"], !(pv is NSNull) {
        guard let pd = pv as? [String: Any] else {
            return (errorResponse(id, "invalid_params", "'params' must be a JSON object"), cmd)
        }
        params = pd
    }
    return (runCommand(id: id, cmd: cmd, params: params), cmd)
}
