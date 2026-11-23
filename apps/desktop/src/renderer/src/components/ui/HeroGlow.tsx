import { cn } from './cn';

/** The signature blurred radial glow (#F9730C → #FFB053 → #A5BBFC → #F4F7FF). */
export function HeroGlow({ className }: { className?: string }) {
  return <div aria-hidden className={cn('hero-glow', className)} />;
}
