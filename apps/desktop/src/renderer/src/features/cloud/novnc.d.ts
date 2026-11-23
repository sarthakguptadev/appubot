/** noVNC's RFB client (`@novnc/novnc` 1.7, ES modules, no types shipped): the parts the cloud desktop view uses. */
declare module '@novnc/novnc' {
  export interface RFBOptions { shared?: boolean; credentials?: { username?: string; password?: string; target?: string }; wsProtocols?: string[] }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket | { send(data: unknown): void; close(): void; readonly readyState: number }, options?: RFBOptions);
    viewOnly: boolean;
    showDotCursor: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power: boolean };
    disconnect(): void;
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
