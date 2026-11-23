/**
 * AppuBot's logo mark, the face of the "Orange tile" app icon (`apps/desktop/scripts/make-icon.mjs`): a dark visor bar
 * tilted -5° with two cream happy eyes in it, in tile units (1024 = the tile edge to edge). Both apps draw it over
 * their own fill: a team's tile wears it on the team's colour (`teamTint`), so every team reads as AppuBot's and still
 * tells apart from the others and from the orange app icon itself. Change it with make-icon.mjs.
 */
export const APP_MARK = {
  /** the tile's edge, the viewBox's size */
  size: 1024,
  visor: { cx: 512, cy: 519, w: 733, h: 326, rot: -5, color: '#151515' },
  /** each eye an upper half circle, centred in the visor's own frame */
  eyes: [{ x: -149, y: 37, r: 72 }, { x: 149, y: 37, r: 72 }],
  eyeColor: '#FFF2E2',
  /** the icon's eye stroke, and a bolder one for tiles under 24 px, where 52 would blur to under a pixel */
  eyeWidth: 52,
  eyeWidthSmall: 72,
} as const;

/** The eye stroke for a mark drawn `size` px wide. */
export function appMarkEyeWidth(size: number): number {
  return size < 24 ? APP_MARK.eyeWidthSmall : APP_MARK.eyeWidth;
}

/** One eye's arc as path data in the visor's frame (centre at 0,0). */
export function appMarkEyePath(e: { x: number; y: number; r: number }): string {
  return `M ${e.x - e.r} ${e.y} A ${e.r} ${e.r} 0 0 1 ${e.x + e.r} ${e.y}`;
}

/** The visor's transform: its centre, then the tilt. */
export const APP_MARK_VISOR_TRANSFORM = `translate(${APP_MARK.visor.cx} ${APP_MARK.visor.cy}) rotate(${APP_MARK.visor.rot})`;
