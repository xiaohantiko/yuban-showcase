import { planFollowup } from './followup.mjs';
import { isQuiet, nextGreeting } from './logic.mjs';

export function confirmedHistory(thread) {
  return (thread.messages ?? []).filter(item => !item.pendingDelivery);
}

function hasConversation(thread) {
  if (thread.confirmedChatFor != null) return thread.confirmedChatFor > 0;
  // Earlier versions only recorded ordinary conversation and searches in history.
  // Exclude search results and unsolicited messages when reading these old threads.
  const history = thread.messages ?? [];
  return history.some((item, i) => item.role === 'assistant' && !item.pendingDelivery && !['greeting', 'search'].includes(item.kind)
    && history[i - 1]?.role === 'user' && history[i - 1].kind !== 'search');
}

export function dueGreeting(thread, settings, now) {
  if (!thread?.optedIn || thread.storyTurn || !thread.lastUserAt || !settings.enabled
      || isQuiet(now, settings) || !hasConversation(thread)) return null;
  if (settings.outreachMode === 'manual') {
    if (now - thread.lastUserAt >= 30 * 86_400_000 || nextGreeting(thread, settings, now) !== now) return null;
    return { anchor: thread.lastUserAt, stage: 1, reason: 'manual', expiresAt: thread.lastUserAt + 30 * 86_400_000 };
  }
  if (thread.confirmedChatFor != null && thread.confirmedChatFor !== thread.lastUserAt) return null;
  // Ordinary replies are stored before transport I/O for deduplication; only confirmed exchanges count.
  const plan = planFollowup({ ...thread, messages: confirmedHistory(thread) }, settings, now);
  return plan && plan.dueAt <= now && now < plan.expiresAt ? plan : null;
}
