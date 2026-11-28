import { useRef, useState, type ReactNode } from 'react';
import { lazyComponent } from '../../lib/lazyComponent';
import { Button, Dialog } from '../ui';
import { ui, useStore, type Modal } from '../../lib/store';
import { answerQuit, quitBody } from '../../lib/quit';
import { QuickSwitcher } from './QuickSwitcher';
import { WhatsNewDialog } from '../../features/whatsNew/WhatsNew';
import { ImageGallery } from '../../features/chat/GalleryDialog';
import { FileViewer } from '../../features/files/FileViewer';
import { LaunchGiftDialog } from '../../features/promo/LaunchGiftDialog';

/*
 * The dialogs a launch rarely needs are chunks of their own (~160 KB the window no longer parses before it can draw):
 * each loads the first time it opens, then stays mounted like the rest, so it animates out. `preloadDialogs` fetches
 * them all in a quiet moment after launch (MainLayout), so even a first open draws at once.
 */
const NewBotDialog = lazyComponent(() => import('../../features/bots/NewBotDialog').then((m) => m.NewBotDialog));
const TeachDialog = lazyComponent(() => import('../../features/skills/TeachDialog').then((m) => m.TeachDialog));
const SkillDialog = lazyComponent(() => import('../../features/skills/SkillDialog').then((m) => m.SkillDialog));
const RoutineDialog = lazyComponent(() => import('../../features/routines/RoutineDialog').then((m) => m.RoutineDialog));
const GroupEditorDialog = lazyComponent(() => import('../../features/groups/GroupEditorDialog').then((m) => m.GroupEditorDialog));
const PairDialog = lazyComponent(() => import('../../features/settings/PairDialog').then((m) => m.PairDialog));
const PhoneAppDialog = lazyComponent(() => import('../../features/settings/PhoneApps').then((m) => m.PhoneAppDialog));
const CloudWelcome = lazyComponent(() => import('../../features/cloud/CloudWelcome').then((m) => m.CloudWelcome));
const CloudDevicesDialog = lazyComponent(() => import('../../features/cloud/CloudDevicesDialog').then((m) => m.CloudDevicesDialog));
const AppsDialog = lazyComponent(() => import('../../features/apps/AppsView').then((m) => m.AppsDialog));

export function preloadDialogs(): void {
  for (const c of [NewBotDialog, TeachDialog, SkillDialog, RoutineDialog, GroupEditorDialog, PairDialog, PhoneAppDialog, CloudWelcome, CloudDevicesDialog, AppsDialog]) void c.preload();
}

/** Mounted from the first time `open` is true (its chunk loading meanwhile), and kept so it can close with its motion. */
function OnceOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [ever, setEver] = useState(open);
  if (open && !ever) setEver(true);
  return ever ? children : null;
}

function ConfirmDialog({ modal }: { modal: Extract<Modal, { kind: 'confirm' }> | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={!!modal}
      onClose={ui.closeModal}
      size="sm"
      title={modal?.title}
      footer={
        <>
          <Button variant="ghost" onClick={ui.closeModal}>Cancel</Button>
          <Button
            variant={modal?.danger ? 'danger' : 'primary'}
            loading={busy}
            data-autofocus
            onClick={async () => {
              if (!modal) return;
              setBusy(true);
              try { await modal.onConfirm(); } finally { setBusy(false); ui.closeModal(); }
            }}
          >
            {modal?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p className="text-copy leading-relaxed text-fg-2">{modal?.body}</p>
    </Dialog>
  );
}

/** Main's "Quit AppuBot?": Cancel, Esc, the backdrop and X all answer no. */
function QuitDialog() {
  const prompt = useStore((s) => s.quitPrompt);
  // keeps its text while it animates out
  const last = useRef(prompt);
  if (prompt) last.current = prompt;
  const working = last.current?.working ?? 0;
  return (
    <Dialog
      open={!!prompt}
      onClose={() => answerQuit(false)}
      size="sm"
      title="Quit AppuBot?"
      footer={
        <>
          <Button variant="ghost" onClick={() => answerQuit(false)}>Cancel</Button>
          <Button variant={working ? 'danger' : 'primary'} data-autofocus onClick={() => answerQuit(true)}>Quit</Button>
        </>
      }
    >
      <p className="text-copy leading-relaxed text-fg-2">{quitBody(working)}</p>
    </Dialog>
  );
}

/** All app-level dialogs stay mounted so their exit animations play. */
export function ModalHost() {
  const modal = useStore((s) => s.modal);
  const appsOpen = useStore((s) => s.appsOpen);
  const close = ui.closeModal;
  return (
    <>
      <OnceOpened open={modal?.kind === 'new-bot'}><NewBotDialog open={modal?.kind === 'new-bot'} onClose={close} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'teach'}><TeachDialog open={modal?.kind === 'teach'} onClose={close} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'skill'}><SkillDialog open={modal?.kind === 'skill'} onClose={close} botId={modal?.kind === 'skill' ? modal.botId : ''} name={modal?.kind === 'skill' ? modal.name : undefined} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'routine'}><RoutineDialog open={modal?.kind === 'routine'} onClose={close} routineId={modal?.kind === 'routine' ? modal.routineId : undefined} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'group'}><GroupEditorDialog open={modal?.kind === 'group'} onClose={close} groupId={modal?.kind === 'group' ? modal.groupId : undefined} withBotId={modal?.kind === 'group' ? modal.withBotId : undefined} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'pair'}><PairDialog open={modal?.kind === 'pair'} onClose={close} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'phone-app'}><PhoneAppDialog open={modal?.kind === 'phone-app'} onClose={close} /></OnceOpened>
      <OnceOpened open={appsOpen}><AppsDialog open={appsOpen} onClose={ui.closeApps} /></OnceOpened>
      <QuickSwitcher open={modal?.kind === 'quick'} onClose={close} />
      <ConfirmDialog modal={modal?.kind === 'confirm' ? modal : null} />
      <OnceOpened open={modal?.kind === 'cloud-welcome'}><CloudWelcome modal={modal?.kind === 'cloud-welcome' ? modal : null} /></OnceOpened>
      <OnceOpened open={modal?.kind === 'cloud-devices'}><CloudDevicesDialog modal={modal?.kind === 'cloud-devices' ? modal : null} /></OnceOpened>
      <WhatsNewDialog />
      <LaunchGiftDialog />
      <ImageGallery />
      <FileViewer />
      <QuitDialog />
    </>
  );
}
