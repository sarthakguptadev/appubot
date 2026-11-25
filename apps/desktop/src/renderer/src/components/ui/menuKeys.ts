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

/**
 * Where a key moves the choice in a radio group of `count` choices whose chosen one is `at`: →/↓ step to the next
 * choice and wrap around, ←/↑ step to the previous choice and wrap around, Home/End jump to the ends. null: the
 * key isn't the group's to handle.
 */
export function radioTarget(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown': return (at + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp': return (at - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
