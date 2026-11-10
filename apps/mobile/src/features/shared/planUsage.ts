// How much of the subscriptions' rolling limits is used, overall and by one agent. Pure: screens only draw this.
import type { AgentEntity, ClaudeIntegrationState, ModelOption, OpenrouterIntegrationState, PlanUsage, PlanWindow, ServerEntity } from '@ouro/contract'
import { windowLabel } from '@ouro/contract'
import { capPct, money, untilText } from '../../design/format.ts'

const FIVE_HOURS = 300
const WEEK = 10_080

/** A window's use now: 0 once it has reset, since the last reading is from before. */
export const usedNow = (window: PlanWindow, now: number) => (window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedFraction)

export interface PlanWindowRow { key: number; label: string; valueText: string }

/** Claude's windows as Settings lists them: "5-hour" and "Weekly", "42% (resets 9:41 AM)". */
export function planWindowRows(usage: PlanUsage, now: number): PlanWindowRow[] {
  return [...usage.windows]
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
    .map((window) => {
      const resets = window.resetsAt !== null && window.resetsAt > now ? ` (resets ${untilText(window.resetsAt, now)})` : ''
      return { key: window.windowMinutes, label: windowName(window.windowMinutes), valueText: `${capPct(usedNow(window, now))}${resets}` }
    })
}

export const NO_READING_YET = 'No reading yet'

/** Signed in to a Claude subscription, so there are plan limits to read (an API key has none). */
export const isClaudeOnPlan = (claude: ClaudeIntegrationState | null) => claude?.status === 'signed_in' && claude.account.method === 'plan'

/**
 * Settings' "Plan usage" rows. The server learns Claude's windows from its turns, so before the first one there is
 * nothing to show but that. Null: no section, as when Claude isn't on a plan and nothing was ever read.
 */
export function claudePlanRows(usage: PlanUsage | null, claudeOnPlan: boolean, now: number): PlanWindowRow[] | null {
  if (usage) return planWindowRows(usage, now)
  return claudeOnPlan ? [{ key: 0, label: 'Usage', valueText: NO_READING_YET }] : null
}

function windowName(windowMinutes: number) {
  if (windowMinutes === FIVE_HOURS) return '5-hour'
  if (windowMinutes === WEEK) return 'Weekly'
  return windowLabel(windowMinutes)
}

/** "~3% of 5h · ~1% of 7d" from its share of the Claude plan; dollars for an agent not on it or before the plan is read. */
export function agentUsageText(agent: Pick<AgentEntity, 'planShare' | 'costUsd'>): string | null {
  if (agent.planShare?.length) {
    return [...agent.planShare]
      .sort((a, b) => a.windowMinutes - b.windowMinutes)
      .map((window) => `~${capPct(window.usedFraction)} of ${windowLabel(window.windowMinutes)}`)
      .join(' · ')
  }
  return agent.costUsd > 0 ? money(agent.costUsd) : null
}

/** The list's top line: "Claude: 63% · ChatGPT: 12% · OpenRouter: $1.20", each plan's longest window once read, and
 * OpenRouter's spend when known (AG-09, AG-10). Claude on a plan and not read yet: "Claude: no reading yet". */
export function planUsageLine(planUsage: ServerEntity['planUsage'], claudeOnPlan: boolean, openRouterSpentUsd: number | null, now: number): string | null {
  const openRouter = openRouterSpentUsd === null ? null : `OpenRouter: ${money(openRouterSpentUsd)}`
  const claude = part('Claude', planUsage.claude, now) ?? (claudeOnPlan && planUsage.claude === null ? `Claude: ${NO_READING_YET.toLowerCase()}` : null)
  const parts = [claude, part('ChatGPT', planUsage.chatgpt, now), openRouter].filter((text) => text !== null)
  return parts.length ? parts.join(' · ') : null
}

/** What OpenRouter says the key has spent; without that, the agents' own estimate of their OpenRouter cost, when any.
 * The server reads OpenRouter on its own schedule; the answer arrives through sync. */
export function openRouterSpentUsd(state: OpenrouterIntegrationState | null, agents: Iterable<Pick<AgentEntity, 'model' | 'costUsd'>>, models: readonly ModelOption[]): number | null {
  if (state?.status === 'configured' && state.spentUsd !== null) return state.spentUsd
  const onOpenRouter = new Set(models.filter((option) => option.provider === 'openrouter').map((option) => option.id))
  const estimate = [...agents].filter((agent) => onOpenRouter.has(agent.model)).reduce((total, agent) => total + agent.costUsd, 0)
  return estimate > 0 ? estimate : null
}

function part(name: string, usage: PlanUsage | null, now: number): string | null {
  const longest = usage?.windows.reduce<PlanWindow | null>((found, window) => (found && found.windowMinutes >= window.windowMinutes ? found : window), null)
  return longest ? `${name}: ${capPct(usedNow(longest, now))}` : null
}

export const planUsageFooter = (machineName: string) =>
  `The subscription's 5-hour and weekly limits as ${machineName} last saw them (it learns them from agents' turns).`
