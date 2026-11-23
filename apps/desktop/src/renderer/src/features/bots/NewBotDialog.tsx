/**
 * Create new bot: one small dialog. The bot as it will look on top (it cheers at each pick), a random name of its own
 * under it (chat-core `randomBotName`; the dice picks another, or type one), the shapes drawn as the bot itself in the
 * chosen colour (LookTile), six to a row, and any characters saved before, under the side panel's own switcher
 * (2026-11-18, the owner's "Shapes, Generate and Image as three options in a switcher, here and wherever the avatar is
 * edited": `PanelTabs`, `LOOK_TABS`): Generate is the look picker's own (`GenerateTab`: describe it, pick one of three),
 * Image takes an SVG and wears its outline (`ImageTab`); a pick goes back to Shapes with it worn. Then the colours. (A Templates tab
 * beside it was taken out on 2026-11-18.)
 *
 * The bot starts on Settings' choices for new bots (agent, model, permissions; computer use on) and sets
 * the rest up itself in its first chat (`ChatService.greet`, core `renderIntroPrompt`): a few questions one at a time,
 * what it's for and how they like it done, then it saves the answers itself.
 * Everything else about it is changed afterwards in its side panel.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BOT_COLORS, botShapesOf } from '@appubot/protocol';
import { randomBotName } from '@appubot/chat-core';
import { Dice } from '../../components/ui/icons';
import { PanelTabs } from '../../components/ui/PanelTabs';
import { BotAvatar, Button, Dialog, Icon, cn } from '../../components/ui';
import { createBot } from '../../lib/actions';
import { getState, useStore } from '../../lib/store';
import { GenerateTab, ImageTab, LOOK_TABS, type LookTab } from './CharacterPicker';
import { SHAPE_LABEL, newBotForm, normalize, randomLook } from './botForm';
import { LookTile } from './LookTile';

const botNames = () => getState().bots.map((b) => b.name);

export function NewBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const [name, setName] = useState(() => randomBotName(botNames()));
  // only the shapes the computer on screen takes (one from before 2026-11-18 refuses the newer ones)
  const listed = useStore((s) => s.system?.botShapes);
  const shapes = useMemo(() => botShapesOf({ botShapes: listed }), [listed]);
  const [look, setLook] = useState(() => randomLook(botShapesOf(getState().system)));
  // a character worn instead of the shape (an image or a generated one); '' is the shape
  const [characterId, setCharacterId] = useState('');
  const [tab, setTab] = useState<LookTab>('bot');
  const characters = useStore((s) => s.characters);
  const charactersOn = useStore((s) => s.charactersSupported);
  const worn = characterId ? characters.find((c) => c.id === characterId) : undefined;
  // the preview cheers at each pick
  const [cheer, setCheer] = useState<number | undefined>(undefined);

  // a name and a look of its own each time it opens
  useEffect(() => {
    if (!open) return;
    setName(randomBotName(botNames()));
    setLook(randomLook(botShapesOf(getState().system)));
    setCharacterId('');
    setTab('bot');
    setCheer(undefined);
  }, [open]);

  const picked = (patch: Partial<typeof look>) => {
    setLook((l) => ({ ...l, ...patch }));
    if (patch.shape) setCharacterId('');
    setCheer((n) => (n ?? 0) + 1);
  };
  const wear = (id: string) => { setCharacterId(id); setTab('bot'); setCheer((n) => (n ?? 0) + 1); };

  const reroll = () => {
    setName((n) => randomBotName(botNames(), n));
    setCheer((n) => (n ?? 0) + 1);
  };
  const form = (from: Parameters<typeof newBotForm>[2]) => newBotForm({
    providerId: settings?.defaultProviderId ?? 'claude-code',
    modelId: settings?.defaultModelId ?? '',
    effort: settings?.defaultEffort ?? 'medium',
    fast: settings?.defaultFast ?? false,
    modeId: settings?.defaultModeId ?? 'auto',
  }, providers, from);

  const create = (e?: FormEvent) => {
    e?.preventDefault();
    // a name emptied by hand is "New Bot", and the bot asks what to call it in its first chat
    // shows at once (lib/actions.ts takes it back with an error if the computer refuses); the bot greets and sets itself up
    void createBot({ ...normalize(form({ ...look, ...(name.trim() ? { name: name.trim() } : {}) })), ...(characterId ? { characterId } : {}), greet: true });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      className="w-[520px]"
      title="Create new bot"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => create()}>Create</Button>
        </>
      )}
    >
        <form onSubmit={create} className="flex flex-col items-center pb-1">
          <div className="flex h-[112px] shrink-0 items-center justify-center">
            {worn ? <BotAvatar figure={worn} color={look.color} size={96} cheerKey={cheer} /> : <BotAvatar shape={look.shape} color={look.color} size={96} cheerKey={cheer} />}
          </div>

          {/* the name sits under the bot like a caption, a random one to start; the dice picks another */}
          <div className="relative mt-2 w-full shrink-0">
            <input
              autoFocus
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="Name your bot"
              aria-label="Name"
              maxLength={60}
              className="squircle h-9 w-full rounded-control bg-transparent px-10 text-center text-lead text-fg outline-none transition-colors duration-150 placeholder:text-muted hover:bg-fg/[.04] focus:bg-fg/[.05]"
            />
            <button
              type="button"
              onClick={reroll}
              aria-label="Another name"
              className="ab-pill ab-press squircle absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-control-sm text-muted outline-none transition-colors hover:bg-surface-2 hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
            >
              <Icon icon={Dice} size={16} />
            </button>
          </div>

          {charactersOn ? <div className="mt-4"><PanelTabs<LookTab> items={LOOK_TABS} value={tab} onChange={setTab} /></div> : null}
          {/* one height for the three tabs, so the dialog never changes size between them (the shapes scroll inside it
              once saved characters add rows) */}
          {/* 4px inside the scroller each way, so a field's focus ring or a tile's outline is never cut at its edge */}
          <div className="-mx-1 mt-2 h-[196px] w-[calc(100%+8px)] shrink-0 overflow-y-auto p-1">
          {tab === 'generate' && charactersOn ? (
            <div className="w-full"><GenerateTab color={look.color} providerId={settings?.defaultProviderId ?? 'claude-code'} modelId={settings?.defaultModelId || undefined} open={open} onPicked={wear} /></div>
          ) : tab === 'image' && charactersOn ? (
            <div className="w-full"><ImageTab onPicked={wear} /></div>
          ) : (
            <div role="radiogroup" aria-label="Shape" className="mx-auto grid w-max grid-cols-6 gap-x-1.5 gap-y-1">
              {shapes.map((s) => (
                <LookTile key={s} figure={s} color={look.color} size={32} label={SHAPE_LABEL[s]} selected={!characterId && s === look.shape} onClick={() => picked({ shape: s })} />
              ))}
              {charactersOn ? characters.map((c) => (
                <LookTile key={c.id} figure={c} color={look.color} size={32} label={c.name} selected={c.id === characterId} onClick={() => wear(c.id)} />
              )) : null}
            </div>
          )}
          </div>

          <div role="radiogroup" aria-label="Colour" className="mt-4 grid shrink-0 grid-cols-5 gap-2">
            {BOT_COLORS.map((c) => {
              const on = look.color.toLowerCase() === c.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`Colour ${c}`}
                  onClick={() => picked({ color: c })}
                  className="flex size-8 items-center justify-center rounded-full outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
                >
                  <span
                    style={{ backgroundColor: c }}
                    className={cn(
                      'block size-6 rounded-full transition-shadow duration-150',
                      on && 'shadow-[0_0_0_3px_var(--ab-content),0_0_0_4.25px_color-mix(in_srgb,var(--ab-fg)_45%,transparent)]',
                    )}
                  />
                </button>
              );
            })}
          </div>
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
    </Dialog>
  );
}
