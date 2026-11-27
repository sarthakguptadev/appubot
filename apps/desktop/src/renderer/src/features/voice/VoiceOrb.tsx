// Voice mode's orb: Rare UI's FluidOrb (components/rare/FluidOrb.tsx, a small WebGL shader in a lazy chunk): white
// running into the bot's own colour (chat-core `orbTones`' vivid tone), drifting. It swells with your voice while it
// listens and with the bot's while it speaks, and its colour churns faster while the bot thinks or talks. Without
// WebGL, or if the canvas fails: a CSS sphere in the same colours that pulses gently with the level.
import { Component, Suspense, lazy, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { mixHex, orbTones } from '@appubot/chat-core';
import { useReading } from './speech';
import { useVoiceState, type VoicePhase } from './useVoiceConversation';

const FluidOrb = lazy(() => import('../../components/rare/FluidOrb'));

export type AgentState = null | 'thinking' | 'listening' | 'talking';

let webgl: boolean | null = null;
/** WebGL starts here; asked once. */
function hasWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webgl = false; }
  return webgl;
}

export function agentStateOf(phase: VoicePhase): AgentState {
  return phase === 'listening' ? 'listening'
    : phase === 'thinking' || phase === 'transcribing' ? 'thinking'
      : phase === 'speaking' ? 'talking' : null;
}

/** your voice while it listens (not the echo of its own while it speaks) */
const micLevel = () => {
  const v = useVoiceState.getState();
  return v.phase === 'listening' && !v.muted ? v.level : 0;
};
const botLevel = () => useReading.getState().level;

/** the canvas failed to start (no context, a lost GPU): the CSS orb takes over */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { webgl = false; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Plain CSS: a soft lit sphere in the two tones, pulsing with the voice now (no WebGL, Reduce motion). */
function CssOrb({ colors, phase, muted, still }: { colors: [string, string]; phase: VoicePhase; muted: boolean; still: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let cur = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = phase === 'speaking' ? botLevel() : micLevel();
      cur += (target - cur) * (1 - Math.exp(-dt / (target > cur ? 0.06 : 0.2)));
      const breathe = still ? 0 : 0.015 * Math.sin((now / 3600) * Math.PI * 2);
      if (ref.current) ref.current.style.transform = `scale(${(0.85 + breathe + Math.min(1, cur) * 0.06).toFixed(4)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, still]);
  const [light, deep] = colors;
  return (
    <div
      ref={ref}
      aria-hidden
      className="size-full rounded-full transition-[filter] duration-300"
      style={{
        background: [
          `radial-gradient(circle at 34% 28%, #ffffffcc 0%, #ffffff00 38%)`,
          `radial-gradient(circle at 62% 70%, ${mixHex(light, '#ffffff', 0.4)}aa 0%, #ffffff00 45%)`,
          `radial-gradient(circle at 40% 35%, ${light} 0%, ${mixHex(light, deep, 0.5)} 55%, ${deep} 100%)`,
        ].join(', '),
        boxShadow: `inset 0 0 0 1px #ffffff40, inset 0 0 24px ${mixHex(light, '#ffffff', 0.5)}80`,
        filter: muted ? 'saturate(0.2) brightness(0.9)' : undefined,
      }}
    />
  );
}

export function VoiceOrb({ color, phase }: { color: string; phase: VoicePhase }) {
  const reduce = useReducedMotion();
  const muted = useVoiceState((s) => s.muted);
  // the bot's colour as an airy tone over a vivid one: the vivid one is what the orb's white runs into
  const colors = useMemo(() => orbTones(color), [color]);
  const fallback = <CssOrb colors={colors} phase={phase} muted={muted} still={!!reduce} />;
  // no frame: the sphere sits on the page itself
  return hasWebGL() ? <GlOrb color={colors[1]} phase={phase} muted={muted} fallback={fallback} /> : fallback;
}

/** how fast the colour drifts in each state, before the voice adds to it (1: Rare UI's own pace) */
const DRIFT: Record<Exclude<AgentState, null> | 'idle', number> = { idle: 0.8, listening: 1, thinking: 3.4, talking: 1.6 };

function GlOrb({ color, phase, muted, fallback }: { color: string; phase: VoicePhase; muted: boolean; fallback: ReactNode }) {
  const state = agentStateOf(phase);
  const live = useRef({ state, muted });
  live.current = { state, muted };
  // the voice's level, smoothed: a quick attack and a slower release, so it reads as a pulse rather than jitter
  const motion = useRef({ level: 0, speed: 1, last: 0 });
  const step = () => {
    const m = motion.current;
    const now = performance.now();
    const dt = m.last ? Math.min(0.1, (now - m.last) / 1000) : 0;
    m.last = now;
    const { state: st, muted: off } = live.current;
    const target = off ? 0 : st === 'talking' ? botLevel() : st === 'listening' ? micLevel() : 0;
    m.level += (target - m.level) * (1 - Math.exp(-dt / (target > m.level ? 0.06 : 0.2)));
    const want = off ? 0.4 : DRIFT[st ?? 'idle'] + Math.min(1, m.level) * (st === 'talking' ? 4 : 2);
    m.speed += (want - m.speed) * (1 - Math.exp(-dt / 0.35));
    return m;
  };
  const getSpeed = () => step().speed;
  // read right after the speed, in the same frame: it breathes, and swells with the voice
  const getScale = () => 0.86 + 0.012 * Math.sin((performance.now() / 3600) * Math.PI * 2) + Math.min(1, motion.current.level) * 0.1;
  return (
    <Fallback fallback={fallback}>
      {/* the CSS orb stands in until the canvas's chunk is here, so the orb is never missing */}
      <Suspense fallback={fallback}>
        <FluidOrb className="size-full" color={color} muted={muted} getSpeed={getSpeed} getScale={getScale} aria-hidden />
      </Suspense>
    </Fallback>
  );
}
