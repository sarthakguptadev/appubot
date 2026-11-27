import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './FluidOrb';

/** A WebGL context that only records what a run asks of it. */
function fakeGl() {
  const resolution: number[][] = [];
  const viewport: number[][] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4, FLOAT: 5, TRIANGLES: 6, LINK_STATUS: 7, COMPILE_STATUS: 8,
    createProgram: () => ({}), createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: () => {}, attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => '', useProgram: () => {}, deleteProgram: () => {},
    createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {}, deleteBuffer: () => {},
    getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    getUniformLocation: (_p: unknown, name: string) => name,
    uniform2f: (loc: string, x: number, y: number) => { if (loc === 'u_resolution') resolution.push([x, y]); },
    uniform1f: () => {}, uniform3f: () => {}, drawArrays: () => {},
    viewport: (_x: number, _y: number, w: number, h: number) => { viewport.push([w, h]); },
  };
  return { gl, resolution, viewport };
}

describe('the fluid orb', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sizes every new program, even on a canvas already that size (a dev double mount, a restored context)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { gl, resolution, viewport } = fakeGl();
    const canvas = { width: 300, height: 150, style: {}, getContext: () => gl } as unknown as HTMLCanvasElement;
    const wrap = { clientWidth: 320, clientHeight: 320 } as HTMLElement;
    const live = { current: {} };

    run(canvas, wrap, live)();
    expect(canvas.width).toBe(640);
    expect(resolution).toEqual([[640, 640]]);

    run(canvas, wrap, live)();
    expect(resolution).toEqual([[640, 640], [640, 640]]);
    expect(viewport).toEqual([[640, 640], [640, 640]]);
  });
});
