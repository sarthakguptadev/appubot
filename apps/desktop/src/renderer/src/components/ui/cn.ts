import { extendTailwindMerge } from 'tailwind-merge';

export type ClassValue = string | false | null | undefined | 0;

/* tailwind-merge so a passed className can override a kit default (`h-8` vs `h-10`, `px-3` vs `px-4`, …).
   Teach it our theme's named font sizes / tracking so they are not mistaken for colours. */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['label', 'caption', 'body', 'body-lg', 'card', 'h1', 'h2', 'metric', 'hero', 'note', 'ui', 'copy', 'lead', 'title', 'heading'],
      tracking: ['display', 'heading', 'ui'],
      radius: ['control-sm', 'control', 'control-lg', 'row', 'pop', 'card', 'sheet', 'pill'],
      shadow: ['field', 'raised', 'raised-hover', 'lift', 'edge', 'card', 'card-hover', 'btn-filled', 'btn-outline', 'focus'],
      ease: ['rare', 'rare-in', 'rare-in-out', 'spring', 'spring-soft', 'spring-bouncy', 'reveal', 'ui', 'out-quint', 'emphasized'],
    },
  },
});

export function cn(...parts: ClassValue[]): string {
  return merge(parts.filter(Boolean).join(' '));
}
