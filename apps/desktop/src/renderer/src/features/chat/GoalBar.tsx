// A thread's goal (protocol `Goal`, core services/goals.ts) above the composer, in the chat's notice card: what the
// bot works toward on its own and where it stands ("Turn 3 of 20 · 4m", Done, Needs you, Paused), with Pause /
// Resume / Stop while it runs or waits, and Dismiss to put a finished one away. A group's room shows its thread's goal
// the same way (`unit: 'messages'`, its own actions).
import type { Goal, Thread } from '@appubot/protocol';
import { goalStatusLine, type GoalUnit } from '@appubot/chat-core';
import { Target } from '../../components/ui/icons';
import { Button } from '../../components/ui';
import { call } from '../../lib/actions';
import { useNow } from '../../lib/hooks';
import { NoticeCard } from './NoticeCard';

type GoalAction = 'pause' | 'resume' | 'stop' | 'clear';

/** A bot's goal in its chat. */
export function GoalBar({ thread }: { thread: Thread }) {
  if (!thread.goal) return null;
  return <GoalCard goal={thread.goal} onAct={(action) => void call('threads.goal', { id: thread.id, action }, { errorTitle: 'Couldn’t change the goal' })} />;
}

/** A goal and its controls, wherever it runs. */
export function GoalCard({ goal, unit = 'turns', onAct }: { goal: Goal; unit?: GoalUnit; onAct: (action: GoalAction) => void }) {
  const now = useNow(goal.status === 'active' ? 1000 : 30_000);
  const act = onAct;
  const running = goal.status === 'active';
  const status = goalStatusLine(goal, now, unit);
  const detail = goal.status === 'blocked' && goal.note ? `${status}: ${goal.note}` : goal.status === 'done' && goal.note ? `${status} · ${goal.note}` : status;
  return (
    <NoticeCard
      icon={Target}
      tone={goal.status === 'blocked' ? 'attention' : undefined}
      spinning={running}
      title={goal.objective}
      detail={<div className="mt-0.5 truncate" title={detail}>{detail}</div>}
    >
      {running ? (
        <>
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => act('pause')}>Pause</Button>
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => act('stop')}>Stop</Button>
        </>
      ) : goal.status === 'paused' || goal.status === 'blocked' ? (
        <>
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => act('clear')}>Drop it</Button>
          <Button size="sm" variant="primary" onClick={() => act('resume')}>Resume</Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" className="text-muted" onClick={() => act('clear')}>Dismiss</Button>
      )}
    </NoticeCard>
  );
}
