/**
 * Where a key moves focus in a menu of `count` items whose focused one is `at` (-1: none, the menu just opened from
 * outside it): ↓/↑ step and wrap around, Home/End jump to the ends. null: the key isn't the menu's to handle.
 */
export function menuTarget(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return at < 0 ? 0 : (at + 1) % count;
    case 'ArrowUp': return at <= 0 ? count - 1 : at - 1;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
