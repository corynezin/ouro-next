// An agent's goal as the Goal screen shows it. Pure: Screen.tsx only draws this.
import type { CommandInput, GoalEntity } from '@ouro/contract'
import { money } from '../../design/format.ts'
import { goalLine } from '../chat/model.ts'
import { goalColorOf, goalMarkerOf } from '../agents/model.ts'
import type { GoalColor } from '../agents/model.ts'
import { nextCycleLine } from '../shared/agentFacts.ts'

/** The interval choices, in seconds, after "Default". A chosen interval that's another joins them. */
export const GOAL_INTERVAL_CHOICES = [60, 300, 600, 1800, 3600, 7200, 21600, 86400] as const

export const intervalText = (seconds: number) =>
  seconds % 86400 === 0 ? `${seconds / 86400}d` : seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`

/** `chosenSeconds` is what `set_goal_interval` takes: null puts the goal back on the server's default. */
export interface IntervalChoice { label: string; chosenSeconds: number | null }

/** The default's length is known only while the goal is on it. */
function intervalChoices(interval: GoalEntity['interval']): { choices: IntervalChoice[]; selected: number } {
  const defaultChoice = { label: interval.kind === 'default' ? `Default (${intervalText(interval.seconds)})` : 'Default', chosenSeconds: null }
  const fixed = interval.kind === 'chosen' ? [...new Set([...GOAL_INTERVAL_CHOICES, interval.seconds])].sort((x, y) => x - y) : [...GOAL_INTERVAL_CHOICES]
  const choices = [defaultChoice, ...fixed.map((seconds) => ({ label: intervalText(seconds), chosenSeconds: seconds }))]
  const selected = interval.kind === 'default' ? 0 : choices.findIndex((choice) => choice.chosenSeconds === interval.seconds)
  return { choices, selected }
}

export type GoalAction = 'pause' | 'resume' | 'reopen' | 'edit' | 'mark_done' | 'clear'

export interface GoalScreenModel {
  stateText: string
  color: GoalColor
  nextCycleText: string | null
  summary: string | null
  text: string
  kindText: string
  checkCommand: string | null
  usedText: string | null
  /** First "Default", which `set_goal_interval` takes as null; then the fixed choices. */
  intervals: IntervalChoice[]
  selectedInterval: number
  actions: GoalAction[]
  notes: string | null
}

export function goalScreenModel(goal: GoalEntity, viewerAddress: string | undefined, now: number): GoalScreenModel {
  const { status, kind } = goal
  const openEnded = kind.kind === 'open_ended'
  const intervals = intervalChoices(goal.interval)
  return {
    stateText: `${goalMarkerOf(goal)} ${goalLine(goal, viewerAddress)}`,
    color: goalColorOf(goal),
    nextCycleText: nextCycleLine(goal, now),
    summary: status.status === 'complete' && status.summary.trim() ? status.summary : null,
    text: goal.text,
    kindText: openEnded ? 'open-ended (never completes)' : 'finishes when met',
    checkCommand: kind.kind === 'checked' ? kind.checkCommand : null,
    usedText: goal.costUsd > 0 ? money(goal.costUsd) : null,
    intervals: intervals.choices,
    selectedInterval: intervals.selected,
    actions: [
      status.status === 'active' ? 'pause' : status.status === 'paused' ? 'resume' : 'reopen',
      'edit',
      ...(status.status !== 'complete' && !openEnded ? ['mark_done' as const] : []),
      'clear',
    ],
    notes: goal.notes.trim() || null,
  }
}

export const GOAL_COPY = {
  newFooter: 'It works on the goal whenever it is idle; your messages come first.',
  replaceFooter: 'Replaces the goal; its counters restart, notes are kept.',
  pauseFooter: 'No more cycles until you resume; you can still talk to it.',
  doneFooter: (checkCommand: string | null) => (checkCommand ? `Its check runs first: ${checkCommand}` : ''),
  pauseTitle: (agentName: string) => `Pause ${agentName}'s goal?`,
  clearTitle: (agentName: string) => `Clear ${agentName}'s goal?`,
  clearMessage: "The agent stays; the goal's files are kept.",
  /** Names the file the server keeps them in, as the reference names NOTES.md. */
  notesTitle: 'Notes (goal-notes.md)',
} as const

export const canSetGoal = (text: string, busy: boolean) => !busy && !!text.trim()

/** What a goal command did, as the note under the form says it. Derived here: the commands answer with the goal itself. */
export type GoalChange =
  | { kind: 'set'; replaced: boolean }
  | { kind: 'interval' }
  | { kind: 'paused' }
  | { kind: 'resumed' }
  | { kind: 'reopened' }
  | { kind: 'marked_done' }
  | { kind: 'cleared' }

/** `goal` is the goal as the command returned it; null after clearing. */
export function goalChangeNote(change: GoalChange, agentName: string, goal: GoalEntity | null): string {
  switch (change.kind) {
    case 'set': {
      const openEnded = goal?.kind.kind === 'open_ended' ? 'open-ended ' : ''
      return `${change.replaced ? 'replaced' : 'set'} ${agentName}'s ${openEnded}goal; it works on it whenever it is idle`
    }
    case 'interval':
      if (!goal) return `${agentName}'s goal interval changed`
      return goal.interval.kind === 'chosen'
        ? `${agentName}'s goal cycles now come ${intervalText(goal.interval.seconds)} after it goes idle`
        : `${agentName}'s goal is back to the default interval (${intervalText(goal.interval.seconds)})`
    case 'paused': return `paused ${agentName}'s goal; no more cycles until you resume (you can still talk to it)`
    case 'resumed': return `resumed ${agentName}'s goal`
    case 'reopened': return `reopened ${agentName}'s goal`
    case 'marked_done': return `marked ${agentName}'s goal complete`
    case 'cleared': return `cleared ${agentName}'s goal (its files are kept); ${agentName} stays`
  }
}

/** set_goal's input. Replacing keeps what this screen can't set: the check command and a chosen interval. */
export function setGoalInput(agentId: string, text: string, openEnded: boolean, current: GoalEntity | undefined): CommandInput<'set_goal'> {
  const kind: GoalEntity['kind'] = openEnded ? { kind: 'open_ended' } : current?.kind.kind === 'checked' ? current.kind : { kind: 'finishing' }
  const intervalSeconds = current?.interval.kind === 'chosen' ? current.interval.seconds : null
  return { agentId, text: text.trim(), kind, intervalSeconds }
}
