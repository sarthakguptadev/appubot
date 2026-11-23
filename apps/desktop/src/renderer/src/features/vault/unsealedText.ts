/**
 * What a page says about an AppuBot computer whose Vault isn't encrypted (cloud-gateway `secretBox.ts`: it has no key
 * of its own yet). "Update it" is only said while an update is there to take (`CloudComputer.fix.upToDate` false):
 * until 2026-11-15 no computer could make a key on its host whatever its version, and the pages told people on the
 * newest one to update all the same.
 */
export type UnsealedPlace = 'carry' | 'page';

const UPDATE_PATH = 'Settings › Account › Manage';

export function unsealedVaultText(cap: string, upToDate: boolean | undefined, place: UnsealedPlace): string {
  const lead = place === 'carry'
    ? `${cap} doesn’t encrypt its Vault yet, so nothing is sent to it.`
    : `${cap} doesn’t encrypt its Vault yet, so what you save here is kept as typed.`;
  if (upToDate === false) {
    return place === 'carry'
      ? `${lead} Update it first (${UPDATE_PATH} › Update), then come back.`
      : `${lead} Update it (${UPDATE_PATH} › Update) to have everything in it encrypted, and to import passwords.`;
  }
  return `${lead} The update that encrypts it isn’t out for this computer yet: ${UPDATE_PATH} will offer it.`;
}
