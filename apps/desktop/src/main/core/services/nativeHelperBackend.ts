/** Computer use through the Swift native helper (native/appubot-helper): the Mac's fallback backend. */
import type { ComputerAction } from '@appubot/protocol';
import type { HelperTransport } from './nativeHelper';
import type { ComputerBackend, Perms, ScreenInfo, Shot } from './computerBackend';
import { clampText, normMod, parseDetail } from './computerHelpers';

/* ============================================================ native helper backend */

export class NativeHelperBackend implements ComputerBackend {
  readonly name = 'native' as const;
  /** image pixels per screen point of the last screenshot */
  private scale: number | null = null;
  private screen: ScreenInfo | null = null;

  constructor(private helper: () => HelperTransport | null, private opts: { defaultMaxWidth: () => number }) {}

  private h(): HelperTransport {
    const t = this.helper();
    if (!t) throw new Error('appubot-helper is not available');
    return t;
  }

  async init(): Promise<void> {
    await this.h().request('ping', {}, 5000);
    await this.permissions();
  }

  async permissions(): Promise<Perms> {
    const r = await this.h().request<{ accessibility: boolean; screen_recording: boolean; input_monitoring?: boolean }>('permissions');
    return { accessibility: !!r.accessibility, screenRecording: !!r.screen_recording, inputMonitoring: r.input_monitoring };
  }

  async requestPermissions(): Promise<void> {
    await this.h().request('request_permissions', { which: ['accessibility', 'screen_recording', 'input_monitoring'] }, 60_000);
  }

  async screenSize(): Promise<ScreenInfo> {
    const r = await this.h().request<{ width: number; height: number; scale: number }>('screen_size');
    this.screen = { width: r.width, height: r.height, scale: r.scale };
    return this.screen;
  }

  async screenshot(o: { maxWidth: number; quality: number }): Promise<Shot> {
    const r = await this.h().request<{ image_base64: string; format: string; width: number; height: number; scale: number }>(
      'screenshot', { max_width: o.maxWidth, format: 'jpeg', quality: o.quality, scale: 1 },
    );
    this.scale = r.scale > 0 ? r.scale : 1;
    return { data: r.image_base64, mimeType: r.format === 'png' ? 'image/png' : 'image/jpeg', width: r.width, height: r.height };
  }

  /** Agent coordinates are in screenshot pixels; the helper wants screen points. */
  private async pt(x: number | undefined, y: number | undefined): Promise<{ x: number; y: number }> {
    if (x === undefined || y === undefined) throw new Error('x and y are required');
    if (this.scale === null) {
      const screen = this.screen ?? (await this.screenSize());
      this.scale = screen.width > 0 ? Math.min(1, this.opts.defaultMaxWidth() / screen.width) : 1;
    }
    const s = this.scale || 1;
    return { x: Math.round((x / s) * 100) / 100, y: Math.round((y / s) * 100) / 100 };
  }

  getScale(): number | null { return this.scale; }

  async act(a: ComputerAction): Promise<{ text?: string }> {
    const h = this.h();
    const d = parseDetail(a.detail);
    const json = (v: unknown) => ({ text: clampText(typeof v === 'string' ? v : JSON.stringify(v)) });
    switch (a.type) {
      case 'click': {
        const p = await this.pt(a.x, a.y);
        const mods = Array.isArray(d.modifiers) ? (d.modifiers as string[]).map(normMod) : [];
        await h.request('click', { ...p, button: (d.button as string) ?? 'left', count: Number(d.count ?? 1), modifiers: mods });
        return {};
      }
      case 'double_click': await h.request('click', { ...(await this.pt(a.x, a.y)), button: 'left', count: 2, modifiers: [] }); return {};
      case 'right_click': await h.request('click', { ...(await this.pt(a.x, a.y)), button: 'right', count: 1, modifiers: [] }); return {};
      case 'move': await h.request('mouse_move', await this.pt(a.x, a.y)); return {};
      case 'drag': {
        const from = await this.pt(a.x, a.y);
        const to = await this.pt(a.toX, a.toY);
        await h.request('drag', { from, to, duration_ms: Number(d.value ?? 400) || 400 });
        return {};
      }
      case 'type': await h.request('type_text', { text: a.text ?? '' }, 120_000); return {};
      case 'key': await h.request('key', { key: a.key ?? '' }); return {};
      case 'hotkey': await h.request('hotkey', { keys: (a.key ?? '').split('+').map((s) => s.trim()).filter(Boolean) }); return {};
      case 'scroll': {
        const p = await this.pt(a.x, a.y);
        const amount = Number(d.amount ?? 5);
        const dir = String(d.direction ?? 'down');
        const dx = dir === 'right' ? amount : dir === 'left' ? -amount : 0;
        const dy = dir === 'down' ? amount : dir === 'up' ? -amount : 0;
        await h.request('scroll', { ...p, dx, dy, lines: true });
        return {};
      }
      case 'open_app': {
        const params: Record<string, unknown> = {};
        if (d.bundle_id) params.bundle_id = d.bundle_id; else params.name = a.app;
        if (d.url) params.url = d.url;
        return json(await h.request('open_app', params, 30_000));
      }
      case 'focus_window': {
        if (d.window_id !== undefined || d.pid !== undefined || d.title !== undefined) {
          const params: Record<string, unknown> = {};
          for (const k of ['window_id', 'pid', 'title']) if (d[k] !== undefined) params[k] = d[k];
          if (a.app && params.pid === undefined && params.window_id === undefined) params.app = a.app;
          return json(await h.request('focus_window', params));
        }
        return json(await h.request('activate_app', { name: a.app ?? d.app }));
      }
      case 'accessibility': {
        const r = await h.request<{ nodes?: unknown; compact?: string }>('ax_tree', {
          ...(typeof d.pid === 'number' ? { pid: d.pid } : {}), max_depth: Number(d.max_depth ?? 10), only_interactive: !!d.only_interactive,
        }, 30_000);
        return json(r.compact ?? r.nodes ?? r);
      }
      case 'clipboard': {
        if (d.op === 'write') { await h.request('clipboard_set', { text: a.text ?? '' }); return { text: 'Clipboard updated.' }; }
        const r = await h.request<{ text?: string }>('clipboard_get');
        return { text: clampText(r.text ?? '') };
      }
      case 'other': {
        if (d.cmd === 'list_apps') return json(await h.request('running_apps'));
        if (d.cmd === 'list_windows') return json(await h.request('list_windows', d.pid !== undefined ? { pid: d.pid } : {}));
        throw new Error(`Unsupported computer command: ${String(d.cmd)}`);
      }
      default:
        throw new Error(`Unsupported action: ${a.type}`);
    }
  }

  async shutdown(): Promise<void> { /* the transport is owned by ComputerService */ }
}
