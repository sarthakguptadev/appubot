// A clip's player with our own controls, for the transcript (features/chat/MediaParts.tsx), the Files panel and the file
// viewer: the browser's own video controls never show.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Pause, Play } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { aspectOf, mediaShapes } from '../../lib/imageCache';

const clock = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');

/**
 * A clip's player: the clip in a box of its own shape (from the first frame when `shapeKey` remembers it from the last
 * time it loaded), with our controls over its foot (play/pause, a track to scrub, where it is of how long) in place of
 * the browser's. A click on the picture plays or pauses it; ← and → on the track step 5 s.
 */
export function ClipPlayer({ src, shapeKey, autoPlay, className }: { src: string; shapeKey?: string; autoPlay?: boolean; className?: string }) {
  const [shape, setShape] = useState(() => (shapeKey ? mediaShapes.get(shapeKey) : undefined));
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(0);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seek = (e: PointerEvent<HTMLDivElement>) => {
    const v = ref.current;
    if (!v || !length || (e.type === 'pointermove' && !e.currentTarget.hasPointerCapture(e.pointerId))) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * length;
  };
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const v = ref.current;
    const by = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
    if (!v || !by) return;
    e.preventDefault();
    v.currentTime = Math.min(length, Math.max(0, v.currentTime + by));
  };
  return (
    <div className={cn('relative max-h-[280px] w-full overflow-hidden rounded-control bg-black', className)} style={{ aspectRatio: aspectOf(shape, '16 / 9') }}>
      <video
        ref={ref}
        preload="metadata"
        playsInline
        autoPlay={autoPlay}
        src={src}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) {
            setShape([v.videoWidth, v.videoHeight]);
            if (shapeKey) mediaShapes.set(shapeKey, [v.videoWidth, v.videoHeight]);
          }
          // a clip saved as it was recorded has no length in its header: seeking past the end finds it
          if (v.duration === Infinity) v.currentTime = 1e101;
          else setLength(Number.isFinite(v.duration) ? v.duration : 0);
        }}
        onDurationChange={(e) => {
          const v = e.currentTarget;
          if (length || !Number.isFinite(v.duration) || v.readyState < 1) return;
          setLength(v.duration);
          if (v.currentTime > 0) v.currentTime = 0;
        }}
        className="size-full cursor-pointer object-contain"
      />
      <div className="absolute inset-x-0 bottom-0 flex h-10 items-center gap-2 bg-gradient-to-t from-black/70 to-transparent pt-2 pr-3 pl-1.5 text-white">
        <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} className="flex size-6 shrink-0 items-center justify-center rounded-[7px] hover:bg-white/15">
          <Icon icon={playing ? Pause : Play} size={14} />
        </button>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(at)}
          aria-valuetext={`${clock(at)} of ${clock(length)}`}
          onPointerDown={seek}
          onPointerMove={seek}
          onKeyDown={step}
          className="relative flex h-6 min-w-0 flex-1 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="h-1 w-full overflow-hidden rounded-full bg-white/30">
            <span className="block h-full rounded-full bg-white" style={{ width: `${length ? (at / length) * 100 : 0}%` }} />
          </span>
        </div>
        <span className="shrink-0 text-note tabular-nums">{clock(at)} / {clock(length)}</span>
      </div>
    </div>
  );
}
