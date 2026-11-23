// Settings › About › Credits: whose work AppuBot is made with, a group at a time (chat-core `creditGroups`: the code
// and designs ported in, what the apps run on, faces and icons, and the speech models).
// The same list feeds the notices file every build writes, which the button at the foot opens: every package the app
// carries with its licence's text.
import { useMemo, useState } from 'react';
import { creditByline, creditGroups, creditLinkText, type Credit } from '@appubot/chat-core';
import { Button, Dialog } from '../../components/ui';
import { ExternalLink, FileText } from '../../components/ui/icons';
import { SettingsCard, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE } from '../../components/ui/SettingsCard';
import { native } from '../../lib/native';

function CreditRow({ credit }: { credit: Credit }) {
  const byline = creditByline(credit);
  return (
    <div className={SETTINGS_ROW}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h4 className={SETTINGS_ROW_TITLE}>{credit.name}</h4>
            {byline ? <span className="text-note text-muted">{byline}</span> : null}
          </div>
          <p className={SETTINGS_ROW_DESCRIPTION}>{credit.used}</p>
        </div>
        {credit.url ? (
          <Button
            size="sm" variant="ghost" iconRight={ExternalLink} className="max-w-[15rem] shrink-0 text-muted"
            aria-label={`Open ${credit.name}`}
            onClick={() => void native().openExternal(credit.url!)}
          >
            <span className="truncate">{creditLinkText(credit.url)}</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function CreditsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = useMemo(() => creditGroups(), []);
  // this build's own file of licences: none in a browser preview, or a build that was never packaged with one
  const [noFile, setNoFile] = useState(false);
  return (
    <Dialog
      open={open} onClose={onClose} size="lg" title="Credits"
      description="AppuBot stands on other people’s work. Thank you to everyone who made it."
      footer={(
        <>
          <span className="mr-auto min-w-0 text-note text-muted">
            {noFile ? 'This build has no licence file. It is in every installed copy.' : 'Every package in the app, with its licence.'}
          </span>
          <Button size="sm" variant="outline" icon={FileText} onClick={() => void native().openNotices().then((ok) => setNoFile(!ok), () => setNoFile(true))}>
            Open licences
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-7 pb-1">
        {groups.map((g) => (
          <section key={g.kind} className="flex flex-col gap-2.5">
            <div>
              <h3 className="text-copy font-semibold tracking-ui text-fg">{g.title}</h3>
              <p className="mt-0.5 text-ui text-muted">{g.line}</p>
            </div>
            <SettingsCard>
              {g.credits.map((c) => <CreditRow key={`${g.kind}:${c.name}`} credit={c} />)}
            </SettingsCard>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
