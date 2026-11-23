/**
 * "Only in the cloud" in the window (chat-core `cloudOnly.ts` has the rules): this Mac's own `settings.cloudOnly`,
 * kept from this Mac's gateway whichever computer is on screen (the store's `settings` are the screen computer's), and
 * read with the Mac's account view into: is the choice offered, does it hold now, which cloud computers can work.
 * The Mac's core enforces it (its routines and Telegram bots stop); the window leaves this Mac out of the switchers and
 * opens on the cloud computer (`ComputerMenu`, `reopenLastComputer`).
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import { cloudOnlyInEffect, cloudOnlyOffered, workingClouds, type CloudSpot } from '@appubot/chat-core';
import type { CloudAccountView, Settings, Snapshot } from '@appubot/protocol';
import { errorMessage, localGateway, type GatewayLike } from '../../lib/gateway';
import { getState, pushToast } from '../../lib/store';
import { useCloud } from './cloudAccount';

/** this Mac's `settings.cloudOnly` (null until read) */
export const useMacCloudOnly = create<{ chosen: boolean | null }>(() => ({ chosen: null }));

const take = (s: Pick<Settings, 'cloudOnly'> | null | undefined) => { if (s) useMacCloudOnly.setState({ chosen: !!s.cloudOnly }); };

/**
 * Follows this Mac's setting from its own gateway (its hello and `settings.updated` come whether or not this Mac is on
 * screen). Mount once, after the gateway is up.
 */
export function watchMacCloudOnly(): () => void {
  let mac: GatewayLike;
  try { mac = localGateway(); } catch { return () => undefined; }
  take(mac.snapshot?.settings);
  const off = mac.onAny((event, payload) => {
    if (event === 'settings.updated') take(payload as Settings);
    else if ((event as string) === 'hello') take((payload as Snapshot | null)?.settings);
  });
  if (useMacCloudOnly.getState().chosen === null) void mac.call('settings.get').then(take).catch(() => undefined);
  return off;
}

export interface CloudOnlyNow {
  /** this Mac's setting */
  chosen: boolean;
  /** the cloud computers the person can work on now, their own first */
  usable: CloudSpot[];
  /** Settings shows the choice */
  offered: boolean;
  /** it holds: this Mac is out of the switchers, its routines and Telegram bots are paused */
  inEffect: boolean;
}

/** what the store holds about this Mac's choice (the setting from the store while this Mac is on screen and nothing else is known yet) */
function chosenNow(): boolean {
  return useMacCloudOnly.getState().chosen ?? getState().settings?.cloudOnly ?? false;
}

export function cloudOnlyOf(chosen: boolean, view: CloudAccountView | null | undefined, supported: boolean | null = true): CloudOnlyNow {
  const usable = supported === false ? [] : workingClouds(view);
  const s = { chosen, usable };
  return { chosen, usable, offered: cloudOnlyOffered(s), inEffect: cloudOnlyInEffect(s) };
}

/** The choice now, outside React. */
export function cloudOnlyNow(): CloudOnlyNow {
  const c = useCloud.getState();
  return cloudOnlyOf(chosenNow(), c.view, c.supported);
}

/** The choice now, in React. */
export function useCloudOnly(): CloudOnlyNow {
  const chosen = useMacCloudOnly((s) => s.chosen);
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  return useMemo(() => cloudOnlyOf(chosen ?? false, view, supported), [chosen, view, supported]);
}

/** Saves this Mac's choice (shown at once; back as it was, with a toast, if the Mac refuses). */
export async function setCloudOnly(on: boolean): Promise<boolean> {
  const was = useMacCloudOnly.getState().chosen;
  if (was === on) return true;
  useMacCloudOnly.setState({ chosen: on });
  try {
    take(await localGateway().call('settings.update', { cloudOnly: on }));
    return true;
  } catch (e) {
    useMacCloudOnly.setState({ chosen: was });
    pushToast({ title: 'Couldn’t change where your bots work', body: errorMessage(e), level: 'error' });
    return false;
  }
}
