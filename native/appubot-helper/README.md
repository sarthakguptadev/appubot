# appubot-helper

Native macOS helper that gives the AppuBot agent computer-use abilities on the user's own Mac:
screenshots, mouse and keyboard input, app and window management, the accessibility (AX) tree,
the clipboard, and an input watcher for "teach mode".

It is a SwiftPM executable with no external dependencies. It needs macOS 13 or later, and macOS 14
or later for the ScreenCaptureKit fallback.

```bash
swift build -c release            # -> .build/release/appubot-helper
scripts/smoke.sh                  # build + read-only smoke test
```

## Protocol

The helper is a long-lived process. It reads **newline-delimited JSON** requests on stdin and
writes newline-delimited JSON on stdout, one object per line, flushed after every line. Nothing
else is ever written to stdout. Logs go to stderr.

```jsonc
// request
{"id": 1, "cmd": "click", "params": {"x": 100, "y": 200}}
// success
{"id": 1, "ok": true, "result": {"x": 100, "y": 200, "button": "left", "count": 1, "modifiers": []}}
// failure
{"id": 1, "ok": false, "error": {"code": "invalid_params", "message": "both 'x' and 'y' must be provided together"}}
// unsolicited event (watcher)
{"event": "input", "kind": "click", "x": 412.5, "y": 88, "button": "left", ...}
```

* `id` can be a number or a string and is echoed back. `params` is optional.
* Commands run **sequentially** on one serial queue, so responses come back in request order.
  Watcher events can arrive between responses at any time. Tell them apart by the `event` key.
* The helper exits when stdin closes (the parent died) or on `quit`.
* Error codes:
  * `parse_error`, `invalid_request`, `unknown_command`, `invalid_params`
  * `not_found`, `permission_denied`
  * `capture_failed`, `launch_failed`, `timeout`
  * `ax_error`, `action_unsupported`, `not_settable`
  * `image_error`, `failed`, `internal_error`

Bad input never crashes the process.

**Debug mode:** `appubot-helper <cmd> '<params json>'` runs one command, prints one response line,
and exits. The exit code is 0 if the command succeeded, 1 if it failed, and 2 if the params JSON
is invalid. `appubot-helper watch_start '{}'` keeps running and prints events until you press
Ctrl-C. `appubot-helper --help` lists the commands.

```bash
.build/release/appubot-helper screenshot '{"max_width": 800, "format": "jpeg"}'
echo '{"id":1,"cmd":"ping"}' | .build/release/appubot-helper
```

### Coordinates

All coordinates are **logical points** in the global Quartz display space. The origin is the
**top-left of the main display**, y grows downward, and secondary displays can have negative
coordinates. CGEvent, CGWindowList and AX frames all use this same space.

Screenshots default to **logical resolution**, so one image pixel equals one point. To convert an
image pixel `(px, py)` to a global point:

```
x = origin.x + px / scale
y = origin.y + py / scale
```

With the defaults (`scale: 1`, main display) this is simply `x = px`, `y = py`.

## Permissions (TCC)

Grant these in **System Settings → Privacy & Security**:

| Permission | Needed for |
| --- | --- |
| **Accessibility** | Posting synthetic mouse/keyboard events (without it macOS silently drops them, and the results contain a `warning`). Also every `ax_*` command and `focus_window`, plus window titles in `list_windows` when Screen Recording is missing. |
| **Screen Recording** | `screenshot` and `window_screenshot`, and window titles from CGWindowList. Without it, capture returns `permission_denied`. |
| **Input Monitoring** | `watch_start` for keyboard events. Without it, the tap is created but keystrokes are never delivered, so the helper refuses with `permission_denied` unless you pass `{"keyboard": false}` or `{"force": true}`. |

**TCC attribution:** macOS attributes these permissions to the *responsible process*. That is the
app bundle that launched the helper, not the helper binary.

* In production, the permission belongs to **AppuBot.app**, the Electron parent that spawns this
  helper.
* In development, it belongs to whatever launched it: Terminal or iTerm, VS Code or Cursor,
  `Electron.app` from `node_modules`, and so on.
* After granting a permission, the parent app usually has to be **restarted**.
* Use `permissions` to check the current state.
* Use `request_permissions` to trigger the system prompts, or `open_settings` to open the right
  pane.

## Commands

The examples show `params → result`. Each result is the `result` field of the response.

### Meta

```jsonc
ping {}                      → {"version":"0.1.0","pid":123,"screen_locked":false,"on_console":true}
permissions {}               → {"accessibility":true,"screen_recording":false,"input_monitoring":false}
request_permissions {"which":["accessibility","screen_recording","input_monitoring"]}
                             → {...same as permissions..., "requested":[...], "note":"..."}
open_settings {"pane":"accessibility"|"screen_recording"|"input_monitoring"|"automation"} → {"opened":true}
wait {"ms":500}              → {"waited_ms":500}
notify {"title":"AppuBot","body":"Done!"}   → {"posted":true}      // via osascript
quit {}                      → {"bye":true}  (then the process exits 0)
```

### Displays & screenshots

```jsonc
displays {} → [{"id":1,"index":0,"bounds":{"x":0,"y":0,"width":1470,"height":956},"scale":2,"is_main":true,
                "pixel_width":2940,"pixel_height":1912}, ...]          // index 0 is always the main display
screen_size {} → {"width":1470,"height":956,"scale":2}                 // main display, points

screenshot {
  "display"?: 0,               // display index (0 = main) or CGDirectDisplayID; default main,
                               // or the display containing `region`
  "region"?: {"x":0,"y":0,"width":800,"height":600},   // global points, clipped to the display
  "scale"?: 1.0,               // multiplier on logical size (2.0 = full Retina detail), (0, 4]
  "format"?: "png"|"jpeg", "quality"?: 0.8,            // quality applies to jpeg
  "max_width"?: 1280           // further downscale if wider
} → {"image_base64":"...","format":"png","width":1470,"height":956,
     "scale":1,               // output pixels per point (use it to map pixels → points)
     "source_scale":2,        // pixels per point of the raw capture
     "origin":{"x":0,"y":0},  // global point of the image's top-left pixel
     "region":{...}, "display_bounds":{...}, "display_id":1, "display_index":0,
     "bytes":123456, "capture_method":"cg"|"sck", "elapsed_ms":42,
     "warning"?: "...", "screen_recording_permission"?: false}   // present when permission is missing: image is likely blank

window_screenshot {"window_id":1234, "scale"?, "format"?, "quality"?, "max_width"?}
  → same image fields + {"window_id","bounds","origin","app","title"}
```

Capture uses `CGDisplayCreateImage` / `CGWindowListCreateImage`, which are synchronous and fast.
It falls back to ScreenCaptureKit when those return nothing, but only if Screen Recording is
granted, so it never triggers a surprise prompt.

### Live video (live view)

The display as H.264 (LiveVideo.swift): a ScreenCaptureKit stream (cursor left out, 4:2:0 straight into the encoder)
into a hardware VideoToolbox session with low-latency rate control, real time, no frame reordering. Only a changed
screen is encoded (a still one sends nothing but two "settle" frames after a change, which sharpen it). Frames come as
events from the encoder's thread, never through the command queue, so a computer-use step never waits behind video.

```jsonc
display_video_start {"display"?: 0, "max_dimension"?: 1280, "bitrate"?: 1500000, "fps"?: 30, "key_interval"?: 10}
  → {"started":true,"running":true,"bounds":{...},"width":1280,"height":832,"blocked"?:"locked", ...settings}
display_video_config {...any of the same}   // applies at once (a new size: new encoder + keyframe); renews the lease
display_video_key {}  → {"sent":true}       // the next frame is a keyframe; a still screen sends the last picture as one
display_video_stop {} → {"stopped":true}

// events
{"event":"video","seq":12,"key":true,"data":"<base64 AVCC: NAL units after 4-byte big-endian lengths>",
 "sps":"<base64>","pps":"<base64>",        // with every keyframe
 "bytes":37596,"width":1280,"height":832,"bounds":{...},"cursor":{"x":..,"y":..},
 "encode_ms":8,"latency_ms":3,"settle"?:true,"low_latency"?:true}
{"event":"video_state","blocked":"locked"|null,"error"?:"...","stopped"?:true}
```

The stream stops by itself 30 s after the last start/config/key (the desktop renews it every 10 s), so a desktop that
went wrong never leaves the screen recorded. A locked screen pauses it (`blocked: "locked"`) until it is unlocked.

### Mouse

`modifiers` is an array (or a `"cmd+shift"` string) of `cmd`, `shift`, `alt`/`option`, `ctrl`/`control`
and `fn`.

```jsonc
cursor_position {}                               → {"x":512.5,"y":300}
mouse_move {"x":500,"y":300,"duration_ms"?:200}  → {"x":500,"y":300}    // eased interpolation if duration
click {"x"?:500,"y"?:300,"button"?:"left"|"right"|"middle","count"?:1|2|3,"modifiers"?:["cmd"]}
      → {"x":500,"y":300,"button":"left","count":2,"modifiers":["cmd"]}   // no x/y = click at cursor
mouse_down {"x"?,"y"?,"button"?} / mouse_up {"x"?,"y"?,"button"?}   // mouse_move in between emits drag events
drag {"from":{"x":10,"y":10},"to":{"x":300,"y":200},"button"?:"left","steps"?:20,"duration_ms"?:300,"modifiers"?:[]}
scroll {"x"?:500,"y"?:400,"dy"?:300,"dx"?:0,"lines"?:false}
      → {"dx":0,"dy":300,"units":"pixels","convention":"dy>0 scrolls down (content moves up); dx>0 scrolls right"}
```

Scroll convention: **`dy > 0` scrolls down** (content moves up, as when reading further down a
page), and `dx > 0` scrolls right. This is independent of the user's "natural scrolling" setting.

### Keyboard

```jsonc
type_text {"text":"Hello, wörld 👋\nnext line","delay_ms"?:0,"chunk_size"?:20} → {"typed_chars":25}
```

`type_text` types arbitrary Unicode, including emoji, CJK and accents, by sending
`keyboardSetUnicodeString` events in chunks of up to 20 characters. `\n` becomes Return and `\t`
becomes Tab. Use `"chunk_size": 1` or a `delay_ms` for apps that drop multi-character events.

```jsonc
key {"key":"enter"}                               → {"key":"enter","keycode":36,"modifiers":[]}
key {"key":"t","modifiers":["cmd","shift"]}
key {"key":"ctrl+shift+t"}                        // xdotool style
key {"key":"Page_Up","hold_ms"?:15}               // xdotool names
key {"key":"cmd+a","dry_run":true}                // resolve without sending anything
hotkey {"keys":["cmd","shift","4"]}               // last element is the key
hotkey {"keys":["cmd+space"]}
```

Key names:

* Letters and digits: `a`–`z`, `0`–`9`. An uppercase letter or a shifted symbol such as `!` adds
  shift automatically.
* Editing and navigation: `enter`/`return`, `tab`, `space`, `backspace`/`delete`,
  `forwarddelete`/`del`, `escape`/`esc`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`,
  `pagedown`.
* Function keys: `f1`–`f20`.
* Modifiers: `cmd`/`command`/`super`, `shift`, `alt`/`option`, `ctrl`/`control`, `fn`, `capslock`.
* Punctuation: `` - = [ ] \ ; ' , . / ` ``, plus names like `minus`, `comma` and `slash`.
* Keypad: `kp0`–`kp9`, `kpenter`.

Key codes are US-ANSI positional (`kVK_*`). On other layouts, use `type_text` for text and `key`
for shortcuts.

### Apps

```jsonc
running_apps {"all"?:false}   // all=true also includes background/accessory processes
  → [{"pid":688,"name":"Finder","bundle_id":"com.apple.finder","is_active":false,"is_hidden":false,
      "path":"/System/Library/CoreServices/Finder.app","activation_policy":"regular"}, ...]
open_app {"name"?:"Safari" | "bundle_id"?:"com.apple.Safari" | "path"?:"/Applications/X.app",
          "activate"?:true, "args"?:[...]}
  → {"pid":123,"bundle_id":"com.apple.Safari","name":"Safari","path":"...","finished_launching":true,"is_active":true}
activate_app {"pid"? | "bundle_id"? | "name"?}   → {...app..., "activated":true}
quit_app {"pid"? | "bundle_id"? | "name"?, "force"?:false, "timeout_s"?:3} → {"terminated":true,...}
frontmost_app {}                 → {"pid":123,"name":"Safari","bundle_id":"com.apple.Safari"}
open_url {"url":"https://example.com","bundle_id"?:"com.google.Chrome"} → {"opened":true}
open_path {"path":"~/Desktop/report.pdf","reveal"?:false}             → {"opened":true}
```

`open_app` looks up a `name` in this order:

1. Running apps.
2. `/Applications`, `/System/Applications` (and `Utilities`), `~/Applications` and
   `/System/Library/CoreServices`, plus one level of subfolders in `/Applications`.
3. Spotlight.

It waits up to 10 seconds for the app to launch.

`activate_app` tries several methods in order. macOS 14 and later can refuse plain activation
requests from a background process:

1. `NSRunningApplication.activate`.
2. AX `AXFrontmost`.
3. Re-opening the app through LaunchServices.

### Windows

```jsonc
list_windows {"on_screen_only"?:true,"pid"?:123,"app"?:"safari","all_layers"?:false}
  → [{"window_id":373,"pid":11400,"app":"Safari","title":"Apple","bounds":{...},"layer":0,"is_on_screen":true,"alpha":1}]
focus_window {"window_id"?:373 | "pid"?:123 | "title"?:"substring"}
  → {"pid":..,"app":..,"title":..,"window_id":..,"bounds":..,"activated":true,"raised":true}
focused_window {} → {"pid":..,"app":..,"title":"...","bounds":{...},"window_id":373,"source":"ax"|"cg"}
```

* Window titles from CGWindowList need Screen Recording. When it is missing, titles are filled in
  through AX if Accessibility is granted.
* AX windows are matched to CG `window_id`s with the long-standing private `_AXUIElementGetWindow`
  call, resolved at runtime. If that call is unavailable, matching falls back to frame and title.

### Accessibility tree

```jsonc
ax_tree {"pid"?:123 (default frontmost), "window"?:"focused"|"all"|"app", "max_depth"?:12,
         "max_nodes"?:1500, "only_interactive"?:false, "include_frames"?:true,
         "include_menu_bar"?:false, "compact"?:true, "enable_web_ax"?:true}
→ {"app":{"pid":..,"name":..,"bundle_id":..}, "window_title":"...", "node_count":214, "truncated":false,
   "nodes":[{"id":0,"parent":null,"depth":0,"role":"AXWindow","title":"Untitled","enabled":true,"focused":true,
             "frame":{"x":..,"y":..,"width":..,"height":..},"children_count":5,"actions":["AXRaise"],"window_id":373},
            {"id":7,"parent":3,"role":"AXButton","subrole":"AXCloseButton","label":"close button",
             "enabled":true,"focused":false,"frame":{...},"children_count":0,"actions":["AXPress"]}, ...],
   "compact":"[0] AXWindow \"Untitled\" (100,80 800×600) focused\n  [3] AXGroup ...\n    [7] AXButton(AXCloseButton) \"close button\" (108,88 14×16)"}
```

* Nodes are a flat list with `parent` links, built breadth-first and capped by `max_nodes`.
* Each node can include these fields: `role`, `subrole`, `title`, `value`, `description`, `help`,
  `label`, `placeholder`, `identifier`, `role_description`, `enabled`, `focused`, `selected`,
  `frame`, `children_count`, `actions`.
* `label` is the first non-empty of AXLabel, AXDescription and AXHelp.
* Strings are truncated to 200 characters.
* `frame` is in global top-left points, so its center can be passed straight to `click`.
* `compact` is an indented depth-first rendering of the same nodes, meant for an LLM to read.
* `window`: `focused` (the default) walks the focused window. `all` walks every window, and the
  menu bar too when `include_menu_bar` is set. `app` walks every window plus the menu bar.
* `only_interactive` keeps buttons, fields, links, menu items, rows and anything with
  AXPress/AXConfirm/AXPick. Parents are re-linked to the nearest kept ancestor.
* `enable_web_ax` sets `AXManualAccessibility` so that Chromium and Electron apps expose their
  web content.
* **Ids are valid until the next `ax_tree` call** and can be passed to `ax_press` and
  `ax_set_value` as `"id"`.

```jsonc
ax_press {"id":7}                                     // from the last ax_tree
ax_press {"x":108,"y":88}                             // hit-test; walks up to an ancestor supporting the action
ax_press {"pid"?:123,"role"?:"AXButton","title":"Save","index"?:0,"action"?:"AXPress"}
  → {...node..., "pid":123, "app":"TextEdit", "performed":"AXPress"}
ax_set_value {"id"|"x","y"|"role"/"title", "value":"hello", "attribute"?:"AXValue", "focus"?:true}
  → {...node..., "set":"AXValue"}
ax_element_at {"x":500,"y":300,"pid"?:123}  → {...node..., "pid","app","ancestors":[{role,title,frame},...],"point"}
ax_focused_element {}                        → {...node..., "pid","app"}
```

The title search in `ax_press` and `ax_set_value` matches title, description, value, placeholder,
identifier and help, case-insensitively. Exact matches come before substring matches.

### Clipboard

```jsonc
clipboard_get {"include_data"?:false} → {"text":"...","types":["public.utf8-plain-text",...],"change_count":21,
                                         "items"?: [{"public.utf8-plain-text":"<base64>", ...}]}
clipboard_set {"text":"hello"}        → {"ok":true,"length":5,"change_count":22}
clipboard_set {"items":[{...}]}       // restore an exact snapshot taken with include_data
```

### Watcher (teach mode)

```jsonc
watch_start {"mouse"?:true,"keyboard"?:true,"screenshots_on_click"?:false,"scale"?:0.5,"force"?:false}
  → {"started":true,"mouse":true,"keyboard":true,"screenshots_on_click":false,"permissions":{...}}
watch_stop {} → {"stopped":true}   // flushes pending typed text first
```

The watcher installs a listen-only `CGEventTap` at session level on the main run loop. It emits
events like these:

```jsonc
{"event":"input","kind":"click","button":"left","count":1,"x":412,"y":88,"modifiers":[],"ts":1760000000000,
 "app":"Safari","pid":11400,"window_title":"Apple",
 "ax":{"role":"AXButton","title":"Sign In","frame":{...}}, "screenshot_base64"?: "<jpeg>"}
{"event":"input","kind":"right_click", ...}
{"event":"input","kind":"drag_end","from":{"x":10,"y":10},"x":300,"y":200,"duration_ms":420, ...}
{"event":"input","kind":"typed","text":"hello world","ts":...,"end_ts":...,"app":"Notes", ...}
{"event":"input","kind":"key","key":"enter","keycode":36,"modifiers":["cmd"],"chars"?:"...", ...}
{"event":"input","kind":"scroll","x":..,"y":..,"dx":0,"dy":240, ...}   // same sign convention as `scroll`
```

* Printable keystrokes without cmd or ctrl are combined into one `typed` event. It is sent after
  600 ms with no typing, or immediately before any non-printable key, click or scroll. Backspace
  edits the pending text.
* Scroll events are added together and sent after 300 ms with no scrolling.
* With `screenshots_on_click`, a JPEG of the display is captured at mouse-down and attached to the
  click.
* Password fields use secure input, so macOS does not deliver those keystrokes to the watcher.
* To change the `mouse`/`keyboard` options, call `watch_stop` and then `watch_start` again.

## Implementation notes

* The main thread runs `NSApplication` with the `.accessory` activation policy, so there is no
  Dock icon. The event tap and permission prompts run on the main run loop.
* stdin is read on a background thread, and commands run on a serial queue.
* Synthetic events are posted at `kCGHIDEventTap` from a `hidSystemState` event source.
* The AX messaging timeout is 3 seconds, so an unresponsive app cannot hang the helper.
