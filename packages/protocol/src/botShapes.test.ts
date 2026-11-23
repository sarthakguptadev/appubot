import { describe, expect, it } from 'vitest';
import { BOT_SHAPES_V1, BotShape, botShapesOf } from './entities';

describe('the shapes a computer takes', () => {
  it('is the first eight for a computer that doesn’t say', () => {
    expect(botShapesOf(null)).toEqual(BOT_SHAPES_V1);
    expect(botShapesOf({})).toEqual(BOT_SHAPES_V1);
    expect(BOT_SHAPES_V1.every((s) => BotShape.options.includes(s))).toBe(true);
  });
  it('is what it lists, in this build’s order, leaving out names this build doesn’t know', () => {
    expect(botShapesOf({ botShapes: [...BotShape.options] })).toEqual(BotShape.options);
    expect(botShapesOf({ botShapes: ['heart', 'circle', 'rocket'] })).toEqual(['circle', 'heart']);
  });
});
