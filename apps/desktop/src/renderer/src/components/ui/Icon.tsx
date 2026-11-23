import { cn } from './cn';
import type { IconComponent } from './icons';

export function Icon({ icon: C, size = 18, strokeWidth, className }: { icon: IconComponent; size?: number; strokeWidth?: number; className?: string }) {
  return <C size={size} strokeWidth={strokeWidth} className={cn('shrink-0', className)} aria-hidden />;
}
