import { describe, expect, it } from 'vitest';
import { FREE_MODELS_PREFERRED, freeModelName, freeModelsToTry, isFreeModel, isRetiredModel, labelFreeModels, nextFreeModel, noteRetiredModel, retiredModelError, withoutRetired } from './freeModels';
import { tidyModels } from './claudeModels';

describe('the free agent’s models', () => {
  it('knows which cost nothing', () => {
    expect(isFreeModel('opencode', 'opencode/big-pickle', 'opencode/Big Pickle')).toBe(true);
    expect(isFreeModel('opencode', 'opencode/mimo-v2.6-flash-free', 'opencode/MiMo-V2.6-Flash Free')).toBe(true);
    expect(isFreeModel('opencode', 'opencode/muse-spark-1.3-contributor', 'opencode/Muse Spark 1.3 Free')).toBe(true);
    expect(isFreeModel('opencode', 'opencode/claude-sonnet-5', 'opencode/Claude Sonnet 5')).toBe(false);
    expect(isFreeModel('opencode', 'github-copilot/gpt-free', 'Free')).toBe(false);
    expect(isFreeModel('claude-code', 'opencode/big-pickle')).toBe(false);
  });

  it('names them without the provider and the Free word', () => {
    expect(freeModelName('opencode/big-pickle', 'opencode/Big Pickle')).toBe('Big Pickle');
    expect(freeModelName('opencode/mimo-v2.6-flash-free', 'opencode/MiMo-V2.6-Flash Free')).toBe('MiMo-V2.6-Flash');
    expect(freeModelName('opencode/glm-5.3-flash-free')).toBe('Glm 5.3 Flash');
    expect(freeModelName('github-copilot/gpt-6.1-terra', 'GPT-6.1 Terra')).toBe('GPT-6.1 Terra');
  });

  it('labels an OpenCode list: free models named so and first, the rest as they are', () => {
    const list = [
      { id: 'github-copilot/gpt-6.1-terra', name: 'GPT-6.1 Terra' },
      { id: 'opencode/longcat-2.5-free', name: 'opencode/LongCat 2.5 Free' },
      { id: 'opencode/claude-sonnet-5', name: 'opencode/Claude Sonnet 5' },
      { id: 'opencode/deepseek-v4.1-flash-free', name: 'opencode/DeepSeek V4.1 Flash Free' },
      { id: 'opencode/big-pickle', name: 'opencode/Big Pickle' },
    ];
    const out = labelFreeModels(list);
    expect(out.map((m) => m.name)).toEqual(['Big Pickle (Free)', 'DeepSeek V4.1 Flash (Free)', 'LongCat 2.5 (Free)', 'GPT-6.1 Terra', 'Claude Sonnet 5']);
    // the same list again changes nothing, and a labelled name still reads as free
    expect(labelFreeModels(out)).toEqual(out);
    expect(isFreeModel('opencode', 'opencode/big-pickle', 'Big Pickle (Free)')).toBe(true);
    expect(tidyModels(list)).toEqual(out);
    // another agent's list is returned untouched
    const claude = [{ id: 'default', name: 'Default' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }];
    expect(labelFreeModels(claude)).toBe(claude);
  });

  it('starts a free chat on the first preferred model the session lists', () => {
    const models = [{ id: 'opencode/longcat-2.5-preview-free' }, { id: 'opencode/big-pickle' }, { id: 'opencode/deepseek-v4.1-flash-free' }];
    const first = (current: string | undefined, list = models) => freeModelsToTry('opencode', current, list)[0];
    expect(first('opencode/longcat-2.5-preview-free')).toBe('opencode/big-pickle');
    expect(first(undefined)).toBe('opencode/big-pickle');
    // then the other preferred ones listed, then any other free one
    expect(freeModelsToTry('opencode', undefined, models)).toEqual(['opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/longcat-2.5-preview-free']);
    // already on the best one, another agent, or on the only free one listed: left alone
    expect(freeModelsToTry('opencode', 'opencode/big-pickle', models)).toEqual([]);
    expect(freeModelsToTry('claude-code', 'opencode/x-free', models)).toEqual([]);
    expect(freeModelsToTry('opencode', 'opencode/x-free', [{ id: 'opencode/x-free' }])).toEqual([]);
    expect(first('opencode/x-free', [{ id: 'opencode/deepseek-v4.1-flash-free' }])).toBe('opencode/deepseek-v4.1-flash-free');
    // on a free one that isn't the best: only the better ones are tried
    expect(freeModelsToTry('opencode', 'opencode/deepseek-v4.1-flash-free', models)).toEqual(['opencode/big-pickle']);
  });

  it('starts on a free model whatever OpenCode itself picked', () => {
    // OpenCode landed on one of the person's own providers (a Copilot model Copilot refuses failed a new install's first message)
    const withOwn = [{ id: 'github-copilot/gemini-4-hydrogen' }, { id: 'opencode/big-pickle' }, { id: 'opencode/deepseek-v4.1-flash-free' }, { id: 'opencode/gpt-6.1-terra', name: 'opencode/GPT-6.1 Terra' }];
    expect(freeModelsToTry('opencode', 'github-copilot/gemini-4-hydrogen', withOwn)).toEqual(['opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free']);
    // one of OpenCode's paid models is no place to start either
    expect(freeModelsToTry('opencode', 'opencode/gpt-6.1-terra', withOwn)[0]).toBe('opencode/big-pickle');
    // a first start lists only the person's own providers, OpenCode's own models come later: the preferred ones, unlisted
    const onlyOwn = [{ id: 'github-copilot/gemini-4-hydrogen' }, { id: 'anyapi/openai/gpt-5' }, { id: 'xai/grok-4.7' }];
    expect(freeModelsToTry('opencode', 'github-copilot/gemini-4-hydrogen', onlyOwn)).toEqual([...FREE_MODELS_PREFERRED]);
    expect(freeModelsToTry('opencode', undefined, [])).toEqual([...FREE_MODELS_PREFERRED]);
    // a paid model is never among them
    for (const id of freeModelsToTry('opencode', undefined, withOwn)) expect(isFreeModel('opencode', id)).toBe(true);
  });

  it('reads a retired model out of the server’s words', () => {
    expect(retiredModelError('Internal error: Model glm-5.3-flash-free has been deprecated. Use deepseek-v4.1-flash-free instead.'))
      .toEqual({ kind: 'retired', instead: 'opencode/deepseek-v4.1-flash-free' });
    expect(retiredModelError('model not found: opencode/minimax-m3.1-flash-free')).toEqual({ kind: 'retired' });
    expect(retiredModelError('The requested model is not supported.')).toEqual({ kind: 'retired' });
    // a model that only can't answer now is never learnt as retired
    expect(retiredModelError('Upstream request failed: Model is unavailable')).toEqual({ kind: 'unavailable' });
    expect(retiredModelError('Rate limit reached, try again later')).toBeNull();
    expect(retiredModelError('Cannot read properties of undefined')).toBeNull();
    expect(retiredModelError(undefined)).toBeNull();
  });

  it('keeps retired models out of every list and every start', () => {
    // shipped as retired: GLM 5.3 Flash, which OpenCode's own catalog still named on 2026-11-18
    expect(isRetiredModel('opencode/glm-5.3-flash-free')).toBe(true);
    const listed = [{ id: 'opencode/big-pickle', name: 'opencode/Big Pickle' }, { id: 'opencode/glm-5.3-flash-free', name: 'opencode/GLM 5.3 Flash Free' }, { id: 'opencode/beam-free', name: 'opencode/Beam Free' }];
    expect(labelFreeModels(listed).map((m) => m.id)).toEqual(['opencode/big-pickle', 'opencode/beam-free']);
    expect(freeModelsToTry('opencode', 'opencode/glm-5.3-flash-free', listed)).toEqual(['opencode/big-pickle', 'opencode/beam-free']);
    // one learnt from a turn drops out the same way; only OpenCode's own ids are taken, once
    expect(noteRetiredModel('opencode/beam-free')).toBe(true);
    expect(noteRetiredModel('opencode/beam-free')).toBe(false);
    expect(noteRetiredModel('github-copilot/gpt-6.1-terra')).toBe(false);
    expect(withoutRetired(listed).map((m) => m.id)).toEqual(['opencode/big-pickle']);
  });

  it('moves a chat off a retired model to the one named in its place, else the best free one', () => {
    const models = [{ id: 'opencode/big-pickle' }, { id: 'opencode/deepseek-v4.1-flash-free' }, { id: 'opencode/longcat-2.5-free' }];
    expect(nextFreeModel('opencode', 'opencode/glm-5.3-flash-free', models, 'opencode/deepseek-v4.1-flash-free')).toBe('opencode/deepseek-v4.1-flash-free');
    expect(nextFreeModel('opencode', 'opencode/glm-5.3-flash-free', models)).toBe('opencode/big-pickle');
    expect(nextFreeModel('opencode', 'opencode/big-pickle', models)).toBe('opencode/deepseek-v4.1-flash-free');
    // a paid model named in its place is never taken
    expect(nextFreeModel('opencode', 'opencode/big-pickle', models, 'opencode/claude-sonnet-5')).toBe('opencode/deepseek-v4.1-flash-free');
    expect(nextFreeModel('claude-code', 'x', models)).toBeNull();
  });
});
