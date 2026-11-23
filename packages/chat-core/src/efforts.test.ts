import { beforeEach, describe, expect, it } from 'vitest';
import { effortsFor, forgetEfforts } from './efforts';

const levels = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const t = (id: string, modelId: string | undefined, efforts = levels, updatedAt = 1) => ({ id, providerId: 'claude-code', modelId, efforts, updatedAt });

describe('effortsFor', () => {
  beforeEach(() => forgetEfforts());

  it('keeps a chat’s own choice of levels', () => {
    const own = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(effortsFor(t('1', 'opus', own), [t('2', 'opus')])).toBe(own);
  });

  it('borrows the same model’s levels from another chat while its own list is empty', () => {
    expect(effortsFor(t('1', 'opus', []), [t('1', 'opus', []), t('2', 'opus')])).toEqual(levels);
  });

  it('remembers a model’s levels after its only chat empties them for a moment (a model switch)', () => {
    effortsFor(t('1', 'sonnet'), [t('1', 'sonnet')]);
    expect(effortsFor(t('1', 'sonnet', [], 2), [t('1', 'sonnet', [], 2)])).toEqual(levels);
  });

  it('shows none for a model never seen with any (Haiku)', () => {
    expect(effortsFor(t('1', 'haiku', []), [t('2', 'opus')])).toEqual([]);
  });

  it('never mixes agents', () => {
    expect(effortsFor({ ...t('1', 'opus', []), providerId: 'codex' }, [t('2', 'opus')])).toEqual([]);
  });
});
