/**
 * FluidOrb: a disc of slowly drifting colour, white at the top running into the colour at the bottom.
 *
 * Ported from Rare UI's `components/ui/fluid-orb.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The shader is Rare UI's, unchanged. Added here for voice mode (features/voice/VoiceOrb.tsx): it fills its box
 * rather than taking a size, its colour and motion are read every frame instead of restarting the canvas (`color`,
 * `getSpeed`: how fast the colour drifts, `getScale`: the disc's size, so it can swell with a voice), `muted` greys
 * it, and a context that can't start or is lost throws from render so the caller's fallback shows.
 */
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '../ui/cn';

export type FluidOrbProps = ComponentProps<'div'> & {
  /** the colour the white runs into (#rgb or #rrggbb) */
  color?: string;
  /** how fast the colour drifts, read every frame (1: Rare UI's own pace) */
  getSpeed?: () => number;
  /** the disc's scale, read every frame (1: fills the box) */
  getScale?: () => number;
  /** greyed out and dimmed */
  muted?: boolean;
};

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_color;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.22;

  vec2 drift = vec2(
    sin(t) + 0.6 * sin(t * 1.7 + 1.3),
    cos(t * 0.8) + 0.6 * cos(t * 1.3 + 2.1)
  );

  vec2 p = vec2(uv.x * 1.8, uv.y * 1.0) + drift * 0.7;

  vec2 q = vec2(fbm(p + drift), fbm(p + vec2(3.2, 1.5) - drift));
  float f = fbm(p + 1.2 * q);

  float g = clamp(1.0 - uv.y, 0.0, 1.0);
  float anchor = smoothstep(0.0, 0.3, uv.y);
  float shade = clamp(g + (f - 0.5) * 0.8 * anchor, 0.0, 1.0);

  vec3 white = vec3(0.99, 1.0, 1.0);
  vec3 light = mix(white, u_color, 0.5);
  vec3 dark = u_color;

  vec3 col = white;
  col = mix(col, light, smoothstep(0.28, 0.52, shade));
  col = mix(col, dark, smoothstep(0.58, 0.88, shade));

  float edge = smoothstep(0.5, 0.49, distance(uv, vec2(0.5)));

  gl_FragColor = vec4(col * edge, edge);
}
`;

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [0.1, 0.45, 0.95];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('no shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'shader failed to compile');
  }
  return shader;
}

/**
 * Starts the canvas; returns what stops it. Throws when WebGL can't start. Each run gets a new program, so its first
 * fit sets the viewport and size even on a canvas already that size (a dev double mount, a restored context).
 */
export function run(canvas: HTMLCanvasElement, wrap: HTMLElement, live: { current: Pick<FluidOrbProps, 'color' | 'getSpeed' | 'getScale'> }): () => void {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
  if (!gl) throw new Error('no webgl');
  const program = gl.createProgram();
  if (!program) throw new Error('no program');
  const vert = compile(gl, gl.VERTEX_SHADER, VERT);
  const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program failed to link');
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uColor = gl.getUniformLocation(program, 'u_color');

  let size = 0;
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(1, Math.round(Math.min(wrap.clientWidth, wrap.clientHeight) * dpr));
    if (px === size) return;
    size = px;
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    gl.viewport(0, 0, px, px);
    gl.uniform2f(uResolution, px, px);
  };
  fit();
  const sized = new ResizeObserver(fit);
  sized.observe(wrap);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = performance.now();
  let time = 0;
  let raf = 0;
  let shown = '';
  const render = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const p = live.current;
    if (!reduce) time += dt * (p.getSpeed?.() ?? 1);
    const color = p.color ?? '#1A73F2';
    if (color !== shown) { shown = color; gl.uniform3f(uColor, ...hexToRgb(color)); }
    gl.uniform1f(uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const scale = p.getScale?.();
    if (scale !== undefined) canvas.style.transform = `scale(${scale.toFixed(4)})`;
    // still under Reduce motion, but the scale (a voice's level) and a new colour are still followed
    raf = requestAnimationFrame(render);
  };
  raf = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(raf);
    sized.disconnect();
    gl.deleteProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    gl.deleteBuffer(buffer);
  };
}

export default function FluidOrb({ color = '#1A73F2', getSpeed, getScale, muted = false, className, style, ...props }: FluidOrbProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ color, getSpeed, getScale });
  live.current = { color, getSpeed, getScale };
  // a canvas that can't start throws from render, so an error boundary's fallback takes its place
  const [failed, setFailed] = useState(false);
  if (failed) throw new Error('the fluid orb could not start');

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let stop: (() => void) | null = null;
    const start = () => { try { stop = run(canvas, wrap, live); } catch { setFailed(true); } };
    const onLost = (e: Event) => { e.preventDefault(); stop?.(); stop = null; };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', start);
    start();
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', start);
      stop?.();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      data-slot="fluid-orb"
      className={cn('relative flex items-center justify-center', className)}
      style={style}
      {...props}
    >
      <canvas
        ref={canvasRef}
        className="aspect-square max-h-full max-w-full rounded-full transition-[filter,opacity] duration-300"
        style={{ width: '100%', filter: muted ? 'saturate(0.15) brightness(0.92)' : undefined, opacity: muted ? 0.8 : 1 }}
      />
    </div>
  );
}
