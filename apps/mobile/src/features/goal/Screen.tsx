// An agent's goal: what it is, how it's going, its notes; set, edit, pause or resume, interval, done, clear.
// Renders goal/model.ts.
import { useLayoutEffect, useMemo, useState } from 'react'
import { Button, Form, Host, Section, Text, Toggle, VStack } from '@expo/ui/swift-ui'
import { disabled, font, foregroundStyle, refreshable, textSelection } from '@expo/ui/swift-ui/modifiers'
import type { CommandInput, CommandName, GoalEntity } from '@ouro/contract'
import { failureText } from '../../core/session/serverApi.ts'
import { C } from '../../design/colors.ts'
import { Field, KV, Note, useBlurFields } from '../../design/form.tsx'
import { ChoiceMenu, confirm } from '../../design/menus.tsx'
import { useNow, useSession, useSessionVersion } from '../../navigation/coreContext.tsx'
import type { ScreenProps } from '../../navigation/routes.ts'
import { agentByRef } from '../shared/agentFacts.ts'
import { canSetGoal, GOAL_COPY, goalChangeNote, goalScreenModel, setGoalInput } from './model.ts'
import type { GoalChange } from './model.ts'

/** A command that answers with the goal, or clear_goal, which answers with nothing. */
type GoalCommand = 'set_goal' | 'set_goal_interval' | 'pause_goal' | 'resume_goal' | 'reopen_goal' | 'mark_goal_done' | 'clear_goal'

export function GoalScreen({ route, navigation }: ScreenProps<'Goal'>) {
  const session = useSession()
  const version = useSessionVersion(session)
  const now = useNow(1000) // "next in 25 s"
  const agent = agentByRef(session.store, route.params.agentRef)
  const goal = agent ? session.store.goals.get(agent.id) : undefined
  const viewerAddress = session.store.viewer?.address
  const model = useMemo(() => (goal ? goalScreenModel(goal, viewerAddress, now) : null), [version, now, goal, viewerAddress])
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [openEnded, setOpenEnded] = useState(false)
  const [asking, setAsking] = useState<'pause' | 'done' | null>(null)
  const [askText, setAskText] = useState('')
  const [busy, setBusy] = useState(false)
  const { field, blurFields } = useBlurFields()
  const agentName = agent?.name ?? route.params.agentRef

  useLayoutEffect(() => { navigation.setOptions({ title: `${agentName}: goal` }) }, [navigation, agentName])

  if (!agent) {
    return <Host style={{ flex: 1 }}><Form><Text modifiers={[foregroundStyle('secondary')]}>{`${agentName} is gone (archived?)`}</Text></Form></Host>
  }

  const run = async <N extends GoalCommand>(name: N, input: CommandInput<N>, change: GoalChange) => {
    await blurFields()
    setBusy(true)
    const result = await session.command(name, input)
    setBusy(false)
    if (!result.ok) {
      setNote(failureText(result.failure))
      return false
    }
    const returned: GoalEntity | null = 'goal' in result.value ? result.value.goal : null
    setNote(goalChangeNote(change, agent.name, returned))
    return true
  }
  const target = { agentId: agent.id }
  const closeAsk = () => { setAsking(null); setAskText('') }
  const startEditing = () => {
    setDraft(goal?.text ?? '')
    setOpenEnded(goal?.kind.kind === 'open_ended')
    setEditing(true)
  }
  const submitGoal = async () => {
    const set = await run('set_goal', setGoalInput(agent.id, draft, openEnded, goal), { kind: 'set', replaced: goal !== undefined })
    if (set) setEditing(false)
  }
  const submitAsk = () => {
    const text = askText.trim() || null
    const kind = asking
    void blurFields().then(() => {
      closeAsk()
      if (kind === 'pause') void run('pause_goal', { agentId: agent.id, reason: text }, { kind: 'paused' })
      else void run('mark_goal_done', { agentId: agent.id, summary: text }, { kind: 'marked_done' })
    })
  }

  const sections = []
  if (goal && model && !editing) {
    sections.push(
      <Section key="state">
        <Text modifiers={[foregroundStyle(C[model.color])]}>{model.stateText}</Text>
        {model.nextCycleText ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{model.nextCycleText}</Text> : null}
        {model.summary ? (
          <VStack alignment="leading" spacing={2}>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>Summary</Text>
            <Text modifiers={[textSelection(true)]}>{model.summary}</Text>
          </VStack>
        ) : null}
      </Section>,
      <Section key="goal" title="Goal">
        <Text modifiers={[textSelection(true)]}>{model.text}</Text>
        <KV k="Kind" v={model.kindText} />
        <KV k="Check" v={model.checkCommand} mono />
        <KV k="Used" v={model.usedText} />
        <ChoiceMenu label="Interval" groups={[{ title: null, choices: model.intervals.map((choice) => ({ key: choice.label, label: choice.label })) }]}
          chosenKey={model.intervals[model.selectedInterval]?.label ?? ''}
          onChoose={(key) => {
            const choice = model.intervals.find((interval) => interval.label === key)
            if (choice) void run('set_goal_interval', { agentId: agent.id, intervalSeconds: choice.chosenSeconds }, { kind: 'interval' })
          }} />
      </Section>,
      asking ? (
        <Section key="ask" title={asking === 'pause' ? GOAL_COPY.pauseTitle(agent.name) : 'Mark the goal done?'}
          footer={<Text>{asking === 'pause' ? GOAL_COPY.pauseFooter : GOAL_COPY.doneFooter(model.checkCommand)}</Text>}>
          <Field ref={field} placeholder={asking === 'pause' ? 'why (optional)' : 'summary (optional)'} value={askText} onChange={setAskText} />
          <Button label={asking === 'pause' ? 'Pause' : 'Done'} modifiers={[disabled(busy)]} onPress={submitAsk} />
          <Button label="Cancel" onPress={() => { void blurFields().then(closeAsk) }} />
        </Section>
      ) : (
        <Section key="actions">
          {model.actions.map((action) => {
            switch (action) {
              case 'pause': return <Button key={action} label="Pause…" onPress={() => { setAsking('pause'); setAskText('') }} />
              case 'resume': return <Button key={action} label="Resume" modifiers={[disabled(busy)]} onPress={() => { void run('resume_goal', target, { kind: 'resumed' }) }} />
              case 'reopen': return <Button key={action} label="Reopen" modifiers={[disabled(busy)]} onPress={() => { void run('reopen_goal', target, { kind: 'reopened' }) }} />
              case 'edit': return <Button key={action} label="Edit…" onPress={startEditing} />
              case 'mark_done': return <Button key={action} label="Mark done…" onPress={() => { setAsking('done'); setAskText('') }} />
              case 'clear': return (
                <Button key={action} label="Clear goal" role="destructive"
                  onPress={() => confirm(GOAL_COPY.clearTitle(agent.name), GOAL_COPY.clearMessage, 'Clear goal', () => { void run('clear_goal', target, { kind: 'cleared' }) })} />
              )
            }
          })}
        </Section>
      ),
      model.notes ? (
        <Section key="notes" title={GOAL_COPY.notesTitle}>
          <Text modifiers={[font({ textStyle: 'footnote' }), textSelection(true)]}>{model.notes}</Text>
        </Section>
      ) : null,
    )
  } else {
    sections.push(
      <Section key="edit" footer={<Text>{goal ? GOAL_COPY.replaceFooter : GOAL_COPY.newFooter}</Text>}>
        <Field ref={field} multiline placeholder="the goal" value={draft} onChange={setDraft} />
        <Toggle label="Open-ended (never completes)" isOn={openEnded} onIsOnChange={setOpenEnded} />
      </Section>,
      <Section key="set">
        <Button label={goal ? 'Replace goal' : 'Set goal'} modifiers={[disabled(!canSetGoal(draft, busy))]} onPress={() => { void submitGoal() }} />
        {editing ? <Button label="Cancel" onPress={() => { void blurFields().then(() => setEditing(false)) }} /> : null}
      </Section>,
    )
  }
  if (note) sections.push(<Section key="note"><Note text={note} /></Section>)

  return (
    <Host style={{ flex: 1 }}>
      <Form modifiers={[refreshable(() => session.refresh())]}>{sections}</Form>
    </Host>
  )
}
