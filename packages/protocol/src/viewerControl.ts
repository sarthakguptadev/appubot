/**
 * The noVNC viewers' control channel (your AppuBot computer's screen port, 6080): the viewer's WebSocket carries the
 * VNC (RFB) bytes as binary frames and, beside them, these JSON messages as text frames. The computer's gateway serves
 * that port itself (the cloud computer's gateway): it opens with a `hello` of its own, so a viewer knows it
 * speaks this (a computer from before answered only RFB bytes: the viewer then has no Take control to offer that
 * pauses the bots); every viewer watches until it asks for `control`, and the VNC input it sends (keys, pointer,
 * clipboard, resizes) only reaches the screen while it has control. The desktop app's viewer (`DesktopView`) speaks
 * it; the pill is the app's own. There is no browser page (noVNC's stock page on a local test computer doesn't speak
 * it: there it takes control with its first key or click, `viewer.ts`).
 */
import { z } from 'zod';
import { ScreenControlSchema } from './entities';

export const VIEWER_CONTROL_VERSION = 1;

/** what a viewer says (text frames) */
export const ViewerToComputerSchema = z.discriminatedUnion('t', [
  /** who watches, for "<name> is in control" (a person's name or email, a device's name) */
  z.object({ t: z.literal('hello'), name: z.string().max(120).optional(), via: z.enum(['desktop', 'browser']).optional() }),
  /** take control (`on`), or give it back */
  z.object({ t: z.literal('control'), on: z.boolean() }),
  /** the person in control is still at it (input the computer can't see, e.g. what a teach session mirrors): renews the idle time */
  z.object({ t: z.literal('alive') }),
]);
export type ViewerToComputer = z.infer<typeof ViewerToComputerSchema>;

/** what the computer says (text frames) */
export const ComputerToViewerSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.number().int() }),
  /** who has control now (null: nobody), whether it is this viewer, and why a request was refused */
  z.object({ t: z.literal('state'), control: ScreenControlSchema.nullable(), mine: z.boolean(), error: z.string().max(300).optional() }),
]);
export type ComputerToViewer = z.infer<typeof ComputerToViewerSchema>;

/** A viewer's text frame, or null when it isn't one of these (ignored). */
export function parseViewerMessage(text: string): ViewerToComputer | null {
  if (text.length > 2048) return null;
  try {
    const r = ViewerToComputerSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch { return null; }
}

/** The computer's text frame, or null when it isn't one of these. */
export function parseComputerMessage(text: string): ComputerToViewer | null {
  try {
    const r = ComputerToViewerSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch { return null; }
}
