// The task catalog: the 100 verbatim prompts joined to their original labels (kind, difficulty, area).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const benchmarkDir = import.meta.dirname

export type Kind = 'feature' | 'change' | 'debug'
export type Difficulty = 'easy' | 'medium' | 'hard'

export interface Task {
  id: string
  prompt: string
  kind: Kind
  difficulty: Difficulty
  area: string
}

interface PromptRow { id: string, prompt: string }
interface LabelRow { task_id: string, kind: Kind, difficulty: Difficulty, area: string }

export function joinCatalog(prompts: readonly PromptRow[], labels: readonly LabelRow[]): Task[] {
  const byId = new Map(labels.map((row) => [row.task_id, row]))
  if (byId.size !== labels.length) throw new Error('the label rows repeat a task id')
  const seen = new Set<string>()
  return prompts.map(({ id, prompt }) => {
    if (seen.has(id)) throw new Error(`task ${id} appears twice`)
    seen.add(id)
    const label = byId.get(id)
    if (!label) throw new Error(`task ${id} has no kind, difficulty or area`)
    return { id, prompt, kind: label.kind, difficulty: label.difficulty, area: label.area }
  })
}

export function loadCatalog(dir = benchmarkDir): Task[] {
  const prompts = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as PromptRow[]
  const initial = JSON.parse(readFileSync(join(dir, 'initial-results.json'), 'utf8')) as { rows: LabelRow[] }
  return joinCatalog(prompts, initial.rows)
}

export interface Selection {
  ids?: readonly string[]
  kinds?: readonly string[]
  difficulties?: readonly string[]
  // Every nth task after the other filters, for a cheap spread across the catalog.
  every?: number
  limit?: number
}

export function selectTasks(catalog: readonly Task[], selection: Selection): Task[] {
  const ids = selection.ids?.length ? new Set(selection.ids) : undefined
  if (ids) for (const id of ids) if (!catalog.some((task) => task.id === id)) throw new Error(`no task ${id} in the catalog`)
  let tasks = catalog.filter((task) =>
    (!ids || ids.has(task.id))
    && (!selection.kinds?.length || selection.kinds.includes(task.kind))
    && (!selection.difficulties?.length || selection.difficulties.includes(task.difficulty)))
  if (selection.every && selection.every > 1) tasks = tasks.filter((_, index) => index % selection.every! === 0)
  if (selection.limit !== undefined) tasks = tasks.slice(0, selection.limit)
  return tasks
}

// "T001,T005-T008" -> T001 T005 T006 T007 T008
export function parseIds(spec: string): string[] {
  return spec.split(',').map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const range = /^T(\d{3})-T(\d{3})$/.exec(part)
    if (!range) {
      if (!/^T\d{3}$/.test(part)) throw new Error(`"${part}" isn't a task id like T001 or a range like T001-T010`)
      return [part]
    }
    const [from, to] = [Number(range[1]), Number(range[2])]
    if (from > to) throw new Error(`the range ${part} runs backwards`)
    return Array.from({ length: to - from + 1 }, (_, index) => `T${String(from + index).padStart(3, '0')}`)
  })
}
