import { APP_MARK, APP_MARK_VISOR_TRANSFORM, appMarkEyePath, appMarkEyeWidth } from '@appubot/chat-core';
import appIcon from '../../assets/app-icon.png';

/** AppuBot's app icon (the orange bot; `scripts/make-icon.mjs` renders it from the Icon Composer bundle). */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return <img src={appIcon} width={size} height={size} alt="AppuBot" draggable={false} className={className} />;
}

/**
 * The app icon's face alone (chat-core `APP_MARK`: the dark visor and the cream happy eyes, placed as on the icon), drawn
 * edge to edge over whatever fill sits behind it: a team's tile wears it on the team's colour. Vector, so it stays crisp
 * at any size; under 24 px the eyes are drawn a little bolder.
 */
export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  const { visor } = APP_MARK;
  return (
    <svg viewBox={`0 0 ${APP_MARK.size} ${APP_MARK.size}`} width={size} height={size} className={className} aria-hidden>
      <g transform={APP_MARK_VISOR_TRANSFORM}>
        <rect x={-visor.w / 2} y={-visor.h / 2} width={visor.w} height={visor.h} rx={visor.h / 2} fill={visor.color} />
        <g fill="none" stroke={APP_MARK.eyeColor} strokeWidth={appMarkEyeWidth(size)} strokeLinecap="round">
          {APP_MARK.eyes.map((e) => <path key={e.x} d={appMarkEyePath(e)} />)}
        </g>
      </g>
    </svg>
  );
}
