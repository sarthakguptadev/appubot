/** Devices & pairing: 6-digit codes → device tokens (hash stored), online flags, revoke/rename. */
import { addressKey, buildPairUrl, machineName, newId, PAIRED_DEVICES_MAX, PairRequestSchema, type ControlDevicesSnapshot, type Device, type NetRoute, type PairingInfo, type PairResponse, type PushRegistration } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { StoredDevice } from '../store';
import { notFound, RpcError } from '../util';

/** What a device record says on the wire: never its token hash or its push token, only whether pushes reach it. */
export function publicDevice(d: StoredDevice, online: boolean): Device {
  const { tokenHash: _h, push, pushOn: _on, pushOff, memberId: _m, memberEmail: _e, identity: _i, ...rest } = d;
  return { ...rest, online, ...(push || pushOff ? { pushOn: !!push && !pushOff } : {}), ...(pushOff ? { pushOff: true } : {}) };
}

/** What a pairing started by the cloud's control server asks for: the role the paired device gets. */
export interface PairingOptions {
  /**
   * `owner` only from the cloud computer's control server (the AppuBot Cloud backend pairing the Mac that bought it:
   * it may then set the agents' keys and change gateway settings there); the wire's `pairing.start` can't ask for it
   */
  role?: 'owner' | 'full';
  /** a team's cloud computer (§6.11): the member the device is for (the backend's account id and email) */
  member?: { id: string; email: string };
}

export class DevicesService {
  private info: PairingInfo | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private online = new Map<string, number>();
  /** the role the open pairing hands out (`full` unless the control server asked for `owner`) */
  private pairingRole: 'owner' | 'full' = 'full';
  /** the team member the open pairing is for (control server only) */
  private pairingMember: { id: string; email: string } | null = null;

  constructor(private ctx: CoreCtx) {}

  list(): Device[] {
    return this.ctx.store.devices.get().devices.map((d) => publicDevice(d, (this.online.get(d.id) ?? 0) > 0));
  }

  get(id: string): Device | undefined { return this.list().find((d) => d.id === id); }
  /** a team's cloud computer: the member a device was paired for (never on the wire) */
  memberOf(id: string): string | undefined { return this.ctx.store.devices.get().devices.find((d) => d.id === id)?.memberId; }
  /** a team's cloud computer: the people whose devices are paired to it (for naming whose logins a bot uses, §6.11) */
  members(): { id: string; email: string }[] {
    const seen = new Map<string, string>();
    for (const d of this.ctx.store.devices.get().devices) if (d.memberId && !seen.has(d.memberId)) seen.set(d.memberId, d.memberEmail ?? '');
    return [...seen].map(([id, email]) => ({ id, email })).sort((a, b) => a.email.localeCompare(b.email));
  }

  pairingInfo(): PairingInfo | null {
    if (this.info && Date.now() > this.info.expiresAt) this.clearPairing();
    return this.info;
  }

  async startPairing(ttlSec = 300, o: PairingOptions = {}): Promise<PairingInfo> {
    // an owner pairing exists only on an AppuBot Cloud computer (the backend's control API asks for it, for the phone
    // or computer that owns the account); on a Mac the window is the owner and every paired device is full or limited
    if (o.role === 'owner' && !this.ctx.deps.cloud) throw new RpcError('forbidden', 'Only an AppuBot Cloud computer pairs an owner device.');
    // a phone pairs only with a computer signed in to AppuBot (the phone checks its own sign-in)
    if (this.ctx.deps.accountRequired && !this.ctx.s.cloudAccount.isSignedIn()) {
      throw new RpcError('sign_in_required', `Sign in to AppuBot on this ${machineName(process.platform)} first (Settings › Account), then pair your phone.`);
    }
    const p = this.ctx.auth.startPairing(ttlSec);
    if (o.member && !this.ctx.deps.cloud) throw new RpcError('forbidden', 'Only an AppuBot Cloud computer pairs a team member.');
    this.pairingRole = o.role ?? 'full';
    this.pairingMember = o.member ?? null;
    // the QR carries every address the gateway admits, Tailscale's and the local network's, whichever the phone
    // pairs over: so it still finds this Mac on the same Wi-Fi with Tailscale off, and over Tailscale away from home
    // (an AppuBot Cloud computer has one address, its public URL, which the backend hands the device: none here)
    const g = this.ctx.s.settings.get().gateway;
    const remote = g.bind === 'loopback' || this.ctx.deps.cloud ? [] : await this.ctx.s.tailscale.hosts({ lan: lanAdmitted(g), fresh: true });
    const hosts = remote.map((h) => ({ ...h, port: this.ctx.gateway.port }));
    // the QR always carries this computer's key, which the phone pins for the end-to-end channel (pairing on the same
    // Wi-Fi goes through it, as does everything after); AppuBot Connect starts with a pairing (so the phone can pair
    // from anywhere), and its room joins the QR while it is on
    this.ctx.s.connect.setPairingOpen(true);
    const connect = await this.ctx.s.connect.pairInfo();
    if (!hosts.length) hosts.push({ host: '127.0.0.1', kind: 'loopback', port: this.ctx.gateway.port });
    const hostName = this.ctx.deps.hostName;
    this.info = {
      code: p.code,
      expiresAt: p.expiresAt,
      hosts,
      ...(connect ?? {}),
      url: buildPairUrl({ hosts: hosts.filter((h) => h.kind !== 'loopback').map((h) => h.host), port: this.ctx.gateway.port, code: p.code, hostName, ...(connect ?? {}) }),
      hostName,
    };
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.clearPairing(), p.expiresAt - Date.now());
    this.ctx.bus.emit('pairing.updated', this.info);
    return this.info;
  }

  cancelPairing(): { ok: true } {
    this.ctx.auth.cancelPairing();
    this.clearPairing();
    return { ok: true };
  }

  private clearPairing(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.pairingRole = 'full';
    this.pairingMember = null;
    this.ctx.s.connect?.setPairingOpen(false);
    const had = this.info !== null;
    this.info = null;
    if (had) this.ctx.bus.emit('pairing.updated', null);
  }

  /**
   * POST /api/pair. Returns [status, body]. `source`: what wrong codes count against (default the address, an IPv6 /64
   * as one; the gateway passes its `pairKey`).
   */
  async pair(body: unknown, remoteIp: string, tailscaleUser?: string, route?: NetRoute, source = addressKey(remoteIp) || remoteIp): Promise<[number, PairResponse | { error: string }]> {
    const parsed = PairRequestSchema.safeParse(body);
    if (!parsed.success) return [400, { error: 'Invalid pairing request' }];
    // a phone app the version policy stopped: told before any code is spent (409: the phone shows the words as they are)
    const stoppedPhone = this.ctx.s.appUpdate.phoneStopped(parsed.data.device);
    if (stoppedPhone) return [409, { error: stoppedPhone }];
    // wrong tries count per address (an IPv6 /64 as one): someone else with the QR can't use up the owner's code
    const r = this.ctx.auth.consumeCode(parsed.data.code, source);
    if (r !== 'ok') {
      if (!this.ctx.auth.pairing) this.clearPairing();
      const msg = r === 'expired' ? `The pairing code expired. Start pairing again on your ${machineName(process.platform)}.`
        : r === 'none' ? `No pairing in progress. Open AppuBot on your ${machineName(process.platform)} → Devices → Pair a phone.`
        : r === 'blocked' ? `Too many wrong codes from this device. Make a new code on your ${machineName(process.platform)} and try again.`
        : 'Wrong pairing code.';
      return [403, { error: msg }];
    }
    const role = this.pairingRole;
    const member = this.pairingMember;
    this.pairingRole = 'full';
    this.pairingMember = null;
    // at most PAIRED_DEVICES_MAX devices (a team member's own on a team's computer); the same device pairing again
    // (reinstalled, its token lost) takes its old place instead of a new one
    const identity = parsed.data.device.id;
    const { previous, counted } = this.pairSlots(identity, member?.id);
    if (!previous && counted >= PAIRED_DEVICES_MAX) {
      this.clearPairing();
      this.ctx.log.info(`devices: pairing refused, ${counted} device(s) already paired${member ? ' for this member' : ''}`);
      return [409, { error: deviceLimitText(member ? 'member' : this.ctx.deps.cloud ? 'cloud' : 'mac') }];
    }
    if (previous) this.revoke(previous.id, { quiet: true });
    const { token, hash } = this.ctx.auth.newDeviceToken();
    const now = Date.now();
    const dev: StoredDevice = {
      id: newId('dev'),
      name: parsed.data.device.name || 'Phone',
      platform: parsed.data.device.platform,
      role,
      pairedAt: now,
      lastSeenAt: now,
      lastIp: remoteIp || undefined,
      tailscaleUser,
      ...(route ? { route } : {}),
      ...(parsed.data.device.appVersion ? { appVersion: parsed.data.device.appVersion.slice(0, 40) } : {}),
      online: false,
      tokenHash: hash,
      identity,
      ...(member ? { memberId: member.id, memberEmail: member.email } : {}),
    };
    // a member paired again through the backend (re-invited after a removal) is on the team again
    this.ctx.store.devices.update((f) => ({ ...f, devices: [...f.devices, dev], ...(member && f.removedMembers?.includes(member.id) ? { removedMembers: f.removedMembers.filter((x) => x !== member.id) } : {}) }));
    // the pairing ends only now that the phone is saved: ending it first would leave nothing for AppuBot Connect to
    // reach, stopping it under a phone that is pairing through it before its answer got out
    this.clearPairing();
    void this.ctx.s.connect.start('paired');
    this.ctx.bus.emit('device.updated', publicDevice(dev, false));
    this.ctx.s.notifications.notify({ title: 'Device paired', body: `${dev.name} can now control AppuBot.`, level: 'success' });
    return [200, { token, deviceId: dev.id, role, hostName: this.ctx.deps.hostName, serverVersion: this.ctx.deps.version }];
  }

  /**
   * What a pairing for `identity` counts against: the devices paired so far (on a team's computer only the member's
   * own; elsewhere the devices paired for nobody), less the record of that same device, which it would replace.
   */
  private pairSlots(identity: string, memberId: string | undefined): { previous: StoredDevice | undefined; counted: number } {
    const mine = this.ctx.store.devices.get().devices.filter((d) => (memberId ? d.memberId === memberId : !d.memberId));
    const previous = mine.find((d) => d.identity === identity);
    return { previous, counted: mine.length - (previous ? 1 : 0) };
  }

  /** `quiet`: the device is pairing again in its own place, so Connect isn't stopped under it */
  revoke(id: string, o: { quiet?: boolean } = {}): { ok: true } {
    const f = this.ctx.store.devices.get();
    const dev = f.devices.find((d) => d.id === id);
    if (!dev) throw notFound('Device', id);
    this.ctx.store.devices.set({ ...f, devices: f.devices.filter((d) => d.id !== id), revoked: [...f.revoked, dev.tokenHash].slice(-500) });
    this.online.delete(id);
    this.ctx.gateway.disconnectDevice(id);
    this.ctx.bus.emit('device.deleted', { id });
    // the last phone gone: nothing to reach this computer through AppuBot Connect
    if (!o.quiet && !this.ctx.s.connect.wanted()) void this.ctx.s.connect.stop('no phones paired');
    return { ok: true };
  }

  /**
   * A team member was removed (§6.11, `/control/members/revoke`, or the heartbeat's `revokedMembers`): every device
   * paired for them is revoked at once, its sockets closed, as `revoke` does. Idempotent; answers how many went.
   */
  revokeMember(memberId: string): number {
    const f = this.ctx.store.devices.get();
    const gone = f.devices.filter((d) => d.memberId === memberId);
    const removed = f.removedMembers ?? [];
    if (!gone.length && removed.includes(memberId)) return 0;
    this.ctx.store.devices.set({
      devices: f.devices.filter((d) => d.memberId !== memberId),
      revoked: [...f.revoked, ...gone.map((d) => d.tokenHash)].slice(-500),
      removedMembers: [...removed.filter((x) => x !== memberId), memberId].slice(-500),
    });
    for (const d of gone) {
      this.online.delete(d.id);
      this.ctx.gateway.disconnectDevice(d.id);
      this.ctx.bus.emit('device.deleted', { id: d.id });
    }
    if (gone.length) this.ctx.log.info(`devices: a team member was removed; ${gone.length} of their device(s) revoked`);
    return gone.length;
  }

  /**
   * A repair on an AppuBot Cloud computer (Fix your computer, `/control/devices/save`): the
   * paired devices as stored, with their tokens' hashes (never a token), the revoked hashes and the removed team
   * members. The backend holds it sealed while it puts an older copy of this computer's files back, then hands it to
   * `mergeSnapshot`.
   */
  snapshot(): ControlDevicesSnapshot {
    if (!this.ctx.deps.cloud) throw new RpcError('forbidden', 'Only an AppuBot Cloud computer hands out its device list.');
    const f = this.ctx.store.devices.get();
    return { devices: f.devices.map((d) => ({ ...d }) as unknown as Record<string, unknown>), revoked: [...f.revoked], removedMembers: [...(f.removedMembers ?? [])], at: Date.now() };
  }

  /**
   * After a restore (`/control/devices/restore`): the list read before it merged into the one the copy brought back.
   * The newer record of a device wins (a re-pair's new token, a rename, a role); devices paired since the copy come
   * back; revoked tokens and removed members are the union of both, and nothing revoked in either is kept, so a device
   * revoked after the copy stays revoked. Sockets of devices that go are closed. Idempotent. Answers how many came back
   * and how many went.
   */
  mergeSnapshot(snap: ControlDevicesSnapshot): { added: number; removed: number } {
    if (!this.ctx.deps.cloud) throw new RpcError('forbidden', 'Only an AppuBot Cloud computer takes a device list.');
    const f = this.ctx.store.devices.get();
    const valid = (d: Record<string, unknown>): d is Record<string, unknown> & StoredDevice =>
      typeof d.id === 'string' && !!d.id && typeof d.tokenHash === 'string' && !!d.tokenHash && typeof d.name === 'string' && (d.role === 'owner' || d.role === 'full' || d.role === 'limited');
    const theirs = snap.devices.filter(valid) as StoredDevice[];
    const revoked = [...new Set([...f.revoked, ...snap.revoked])];
    const gone = new Set(revoked);
    const removedMembers = [...new Set([...(f.removedMembers ?? []), ...(snap.removedMembers ?? [])])];
    const removedSet = new Set(removedMembers);
    const keep = (d: StoredDevice) => !gone.has(d.tokenHash) && !(d.memberId && removedSet.has(d.memberId));
    const merged = [...theirs.filter(keep), ...f.devices.filter((d) => keep(d) && !theirs.some((t) => t.id === d.id))];
    const added = merged.filter((d) => !f.devices.some((x) => x.id === d.id && x.tokenHash === d.tokenHash));
    const dropped = f.devices.filter((d) => !merged.some((x) => x.id === d.id));
    this.ctx.store.devices.set({ ...f, devices: merged, revoked: revoked.slice(-500), removedMembers: removedMembers.slice(-500) });
    for (const d of dropped) {
      this.online.delete(d.id);
      this.ctx.gateway.disconnectDevice(d.id);
      this.ctx.bus.emit('device.deleted', { id: d.id });
    }
    for (const d of added) this.ctx.bus.emit('device.updated', publicDevice(d, (this.online.get(d.id) ?? 0) > 0));
    this.ctx.log.info(`devices: merged the list from before a repair: ${added.length} back, ${dropped.length} gone`);
    return { added: added.length, removed: dropped.length };
  }

  /** whether a team member was removed from this computer (a pairing for them comes only through the backend again) */
  memberRemoved(memberId: string): boolean { return !!this.ctx.store.devices.get().removedMembers?.includes(memberId); }

  /**
   * A team member's role changed (§6.11, `/control/members/role`): an admin's devices are owners, a member's full. A
   * connected device is dropped so it reconnects with the new role (roles are read at sign-in). Answers how many.
   */
  setMemberRole(memberId: string, role: 'owner' | 'full'): number {
    if (role === 'owner' && !this.ctx.deps.cloud) throw new RpcError('forbidden', 'Only an AppuBot Cloud computer has owner devices.');
    const changed: StoredDevice[] = [];
    this.ctx.store.devices.update((f) => ({ ...f, devices: f.devices.map((d) => (d.memberId === memberId && d.role !== role ? (changed.push({ ...d, role }), { ...d, role }) : d)) }));
    for (const d of changed) {
      this.ctx.gateway.reconnectDevice(d.id, 'Your role on this team changed.');
      this.ctx.bus.emit('device.updated', publicDevice(d, (this.online.get(d.id) ?? 0) > 0));
    }
    return changed.length;
  }

  rename(id: string, name: string): Device {
    if (!name.trim()) throw new RpcError('invalid_params', 'Name is required');
    let out: StoredDevice | undefined;
    this.ctx.store.devices.update((f) => ({ ...f, devices: f.devices.map((d) => (d.id === id ? (out = { ...d, name: name.trim() }) : d)) }));
    if (!out) throw notFound('Device', id);
    const pub = publicDevice(out, (this.online.get(id) ?? 0) > 0);
    this.ctx.bus.emit('device.updated', pub);
    return pub;
  }

  /**
   * A phone's own notifications from here (`devices.setPush`): its registration, or null to drop it. `turnOn` (the
   * user switched them on on the phone) also undoes this computer's switch for it.
   */
  setPush(deviceId: string, push: PushRegistration | null, turnOn = false): { pushOn: boolean } {
    const pub = this.change(deviceId, (d) => {
      const { push: _old, pushOff, ...rest } = d;
      const off = pushOff && !turnOn;
      return { ...rest, ...(push ? { push: { ...push, at: Date.now() } } : {}), ...(off ? { pushOff: true } : {}) };
    });
    return { pushOn: !!pub.pushOn };
  }

  /** This computer's switch for one phone's notifications (Settings › Devices). */
  setNotifications(id: string, on: boolean): Device {
    return this.change(id, (d) => {
      const { pushOff: _off, ...rest } = d;
      return on ? rest : { ...rest, pushOff: true };
    });
  }

  /** The relay said this token is dead (the app was removed, or it's another app's): forget it, if it's still the one. */
  dropPush(id: string, token: string): void {
    const d = this.ctx.store.devices.get().devices.find((x) => x.id === id);
    if (!d?.push || d.push.token !== token) return;
    this.change(id, (x) => {
      const { push: _p, ...rest } = x;
      return rest;
    });
    this.ctx.log.info(`push: ${d.name}'s registration expired; it registers again when it next connects`);
  }

  private change(id: string, fn: (d: StoredDevice) => StoredDevice): Device {
    let out: StoredDevice | undefined;
    this.ctx.store.devices.update((f) => ({ ...f, devices: f.devices.map((d) => (d.id === id ? (out = fn(d)) : d)) }));
    if (!out) throw notFound('Device', id);
    const pub = publicDevice(out, (this.online.get(id) ?? 0) > 0);
    this.ctx.bus.emit('device.updated', pub);
    return pub;
  }

  /** Called by the gateway on connect/disconnect of a paired device. */
  setOnline(id: string, online: boolean, ip?: string, tailscaleUser?: string, route?: NetRoute, appVersion?: string): void {
    const n = Math.max(0, (this.online.get(id) ?? 0) + (online ? 1 : -1));
    this.online.set(id, n);
    let out: StoredDevice | undefined;
    this.ctx.store.devices.update((f) => ({
      ...f,
      devices: f.devices.map((d) => (d.id === id ? (out = { ...d, lastSeenAt: Date.now(), ...(ip ? { lastIp: ip } : {}), ...(tailscaleUser ? { tailscaleUser } : {}), ...(route ? { route } : {}), ...(appVersion ? { appVersion: appVersion.slice(0, 40) } : {}) }) : d)),
    }));
    if (out) this.ctx.bus.emit('device.updated', publicDevice(out, n > 0));
  }
}

/** Whether the gateway admits peers on the local network, so their addresses are worth handing to phones. */
export function lanAdmitted(g: { bind: string; allowLan: boolean }): boolean {
  return g.bind === 'all' || (g.bind === 'tailscale' && g.allowLan);
}

/** Why a new device can't pair: the computer already keeps the most it allows (`PAIRED_DEVICES_MAX`). */
export function deviceLimitText(where: 'mac' | 'cloud' | 'member'): string {
  const n = PAIRED_DEVICES_MAX;
  if (where === 'member') return `You already have ${n} devices on this team’s computer, the most each person can. Remove one in Settings › Devices, then try again.`;
  if (where === 'cloud') return `Your AppuBot computer already has ${n} devices paired, the most it allows. Remove one in Settings › Devices, then try again.`;
  return `This ${machineName(process.platform)} already has ${n} devices paired, the most it allows. Remove one in AppuBot › Settings › Devices on it, then pair again.`;
}
