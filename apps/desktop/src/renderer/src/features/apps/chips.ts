/**
 * The Connect apps popup's category chips: how many fit on one line, and how wide those are. All of them, when the
 * line holds every one; else as many as leave room for the More button that holds the rest (the first always shows).
 */
export function chipsThatFit(widths: readonly number[], room: number, gap: number, moreRoom: number): { count: number; width: number } {
  const all = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (all <= room) return { count: widths.length, width: all };
  let count = 0;
  let width = 0;
  for (const w of widths) {
    const next = width + w + (count ? gap : 0);
    if (count && next > room - moreRoom) break;
    width = next;
    count++;
  }
  return { count, width };
}
