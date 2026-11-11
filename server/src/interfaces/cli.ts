// `ouro`: a thin client of ourod's local socket. It holds no state and decides nothing. A send either prints a success or
// fails visibly. A restart of ourod is routine, so unreachable means retry, with the same idempotency key, for a while.
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { request } from 'node:http'
import { chatHandle, displayStateOf } from '@ouro/contract'
import { DEFAULT_EXPORT_COMMAND, NotPublished, publishCommittedApp } from '../app/app-publishing.ts'
import type { PublishedApp } from '../app/app-publishing.ts'
import type { RegisterUpdateInput } from '../app/app-updates.ts'
import type { AgentDisplayState, AgentEntity, ComputerEntity, RemoteAgentEntity, ApiError, AskEntity, ChatEntity, CommandName, CommandOutput, GoalEntity, HistoryPage, MessageEntity, Snapshot, SearchPage, BaseStatus } from '@ouro/contract'

const HELP = `ouro: talk to your agents, and to the other agents if you are one

  ouro send <agent|agent@computer|human> [--fyi] [--file <path>]... "message"   (or the message on stdin)
  ouro send '#group' [--file <path>]... "message"               post in a group (quote it: a bare # starts a shell comment)
  ouro send all [--fyi] [--file <path>]... "message"            every other running agent
  ouro reply [--file <path>]... "message"                        answer the last message, in its chat
  ouro ask <human> [--blocked|--urgent] [--choice "x"]... "question"
  ouro withdraw-ask <ask-id>
  ouro relay <agent> [--ask <ask-id>] "the person's words"      master only: pass the person's own words on, as theirs
  ouro goal set [--open-ended] [--check "<command>"] [--every <seconds>] [--for <agent>] "goal"
  ouro goal pause ["question or reason"] | resume | reopen | clear | done ["summary"] [--for <agent>]
  ouro goal every <seconds|default> [--for <agent>]
  ouro goal [show] [--for <agent>]                              the goal, its state and notes
  ouro goals                                                     every agent's goal
  ouro done "summary"                                            report to your parent and finish
  ouro spawn <new-name>[@computer] [--folder <dir>] [--model <m>] "task"    start a helper, here or on another computer
  ouro new [--name <n>] [--computer <c>] [--folder <dir>] [--model <m>] "task"    start an agent, naming it from the task if unnamed
  ouro list                                                      all agents, their state and what they did lately
  ouro chats                                                     the groups here; * = you're in it
  ouro chats read '#group' [-n <count>]                          its latest messages
  ouro chats new <name> <member>...                              a new group, you included
  ouro chats join '#group' | add|remove '#group' <member>
  ouro stop|interrupt|archive <agent|agent@computer>   ouro unarchive <agent>
  ouro set-model <agent|agent@computer> <model>
  ouro move <agent> <computer>                                   hand it to another computer at the end of its turn; files go by git
  ouro merge <agent>                                             merge a stopped agent's branch into the branch it started from
  ouro log <agent>                                               what it said and did
  ouro search <words>                                            messages holding all the words, newest first
  ouro why <agent>                                               its state, and the transitions that led there
  ouro pair [--invite <person>]                                  a one-time code for a phone
  ouro devices                                                   the paired phones, whose they are, when last seen
  ouro devices revoke <device>                                   (a person only) its token stops working at once
  ouro identity                                                  which server this is
  ouro computers                                                 the person's other computers: online or not, trust, agents
  ouro computers invite                                          a one-use command to run on another computer, for 30 minutes
  ouro computers join <address> <code>                           on the other computer: join the one that made the invite
  ouro computers trust <name> full|limited | remove <name>
  ouro networks                                                  the networks this server holds keys for, and the computers in each
  ouro pull <agent@computer> [--name <n>]                        a paused copy of an agent in a shared network; the original stays
  ouro start-pulled <agent>                                      let a pulled copy run
  ouro push-memory <computer> [--folder <dir>]                   send a project's shared notes into a shared network (yours if no folder)
  ouro memory sync                                               share your personal notes with every project, and take in theirs
  ouro deploy [<commit>]                                         build, verify and switch to a server version; waits for the truth
  ouro release-status                                            what's live and what's the last proven version
  ouro update                                                    check the followed branch now, and deploy a new head
  ouro update follow <branch> [<remote>] | off                   (a person only) follow a branch of a remote, default origin
  ouro publish [--app <folder>]                                  export the committed app and send it to the person's phone
  ouro base                                                      the base this machine has, the one offered, and how an update stands
  ouro base take <n>                                             take the offered base n, for the owner
  ouro base resolve                                              after a conflict, start an agent to merge it
  ouro base drop                                                 after a conflict, throw the merge away; the base stays offered
  ouro base continue                                             carry on with a base update once its conflicts are resolved and committed
`

export class CliFailure extends Error {}

interface SocketResponse {
  status: number
  body: unknown
}

const RETRY_INTERVAL_MS = 250

function isConnectionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ECONNRESET' || code === 'EPIPE'
}

class Client {
  private readonly socketPath: string
  private readonly credential: string | null
  private readonly retryWindowMs: number

  constructor(environment: NodeJS.ProcessEnv) {
    const socketPath = environment.OURO_SOCKET
    if (!socketPath) throw new CliFailure('OURO_SOCKET is not set, so there is no server to talk to')
    this.socketPath = socketPath
    this.credential = environment.OURO_AGENT_CREDENTIAL ?? null
    this.retryWindowMs = Number(environment.OURO_CLI_RETRY_MS ?? 120_000)
  }

  private once(method: string, path: string, body: Buffer | null, headers: Record<string, string>): Promise<SocketResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = request({
        socketPath: this.socketPath,
        method,
        path,
        headers: { ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}), ...headers },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: response.statusCode ?? 0, body: text.length > 0 ? JSON.parse(text) : null })
          } catch {
            reject(new CliFailure(`the server answered something unreadable: ${text.slice(0, 200)}`))
          }
        })
      })
      outgoing.on('error', reject)
      outgoing.end(body ?? undefined)
    })
  }

  async call(method: string, path: string, body: Buffer | null = null, headers: Record<string, string> = {}): Promise<unknown> {
    const deadline = Date.now() + this.retryWindowMs
    for (;;) {
      let result: SocketResponse
      try {
        result = await this.once(method, path, body, headers)
      } catch (error) {
        if (!isConnectionFailure(error)) throw error
        if (Date.now() >= deadline) throw new CliFailure(`the server isn't reachable at ${this.socketPath}. Nothing was sent; try again.`)
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
        continue
      }
      if (result.status >= 200 && result.status < 300) return result.body
      const apiError = (result.body as { error?: ApiError } | null)?.error
      if (apiError?.retryable && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
        continue
      }
      throw new CliFailure(apiError ? `${apiError.message} (${apiError.code})` : `the server answered ${result.status}`)
    }
  }

  command<N extends CommandName>(name: N, input: unknown): Promise<CommandOutput<N>> {
    // One key per invocation, so the retries above can't double anything.
    const body = Buffer.from(JSON.stringify({ idempotencyKey: randomUUID(), input }))
    return this.call('POST', `/v2/commands/${name}`, body, { 'content-type': 'application/json' }) as Promise<CommandOutput<N>>
  }

  snapshot(): Promise<Snapshot> {
    return this.call('GET', '/v2/snapshot') as Promise<Snapshot>
  }
}

interface ParsedArguments {
  positionals: string[]
  flags: Map<string, string[]>
  switches: Set<string>
}

function parseArguments(args: string[], valueFlags: readonly string[], switchFlags: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], flags: new Map(), switches: new Set() }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      parsed.positionals.push(...args.slice(index + 1))
      break
    }
    if (valueFlags.includes(arg)) {
      const value = args[++index]
      if (value === undefined) throw new CliFailure(`${arg} needs a value`)
      parsed.flags.set(arg, [...(parsed.flags.get(arg) ?? []), value])
    } else if (switchFlags.includes(arg)) {
      parsed.switches.add(arg)
    } else if (arg.startsWith('--')) {
      throw new CliFailure(`unknown option ${arg}. See: ouro help`)
    } else {
      parsed.positionals.push(arg)
    }
  }
  return parsed
}

/** Whether a hook's input says a file in the memory folder was written. Input without a file (a session starting) says
 * yes: everything may have changed. */
export function wroteToMemory(hookInput: string, memoryDir: string | undefined): boolean {
  if (!memoryDir) return false
  let filePath: unknown
  try {
    filePath = (JSON.parse(hookInput) as { tool_input?: { file_path?: unknown } }).tool_input?.file_path
  } catch {
    return true
  }
  if (typeof filePath !== 'string') return true
  const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
  return filePath.endsWith('.md') && real(dirname(filePath)) === real(memoryDir)
}

function messageText(parsed: string[], stdin: () => string, what: string): string {
  if (parsed.length > 0) return parsed.join(' ')
  const text = stdin()
  if (text.trim() === '') throw new CliFailure(`${what} is empty: pass it as an argument or on stdin`)
  return text.replace(/\n$/, '')
}

function describeDisplay(display: AgentDisplayState): string {
  switch (display.display) {
    case 'running': return display.toolName ? `running: ${display.toolName}` : `running: ${display.activity}`
    case 'stopped': return `stopped: ${display.reason}`
    case 'done': return 'done'
    case 'offline': return 'offline'
    case 'archived': return 'archived'
    case 'moved': return `moved: ${display.to}`
  }
}

async function attachmentIds(client: Client, files: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const path of files) {
    const fileName = path.split('/').pop() ?? 'file'
    const attachment = await client.call('POST', '/v2/attachments', readFileSync(path), { 'x-file-name': encodeURIComponent(fileName), 'content-type': 'application/octet-stream' }) as { id: string }
    ids.push(attachment.id)
  }
  return ids
}

async function requireAgent(client: Client, name: string | undefined): Promise<AgentEntity> {
  if (!name) throw new CliFailure('which agent?')
  const snapshot = await client.snapshot()
  const found = snapshot.agents.filter((agent) => agent.name === name)
  const active = found.find((agent) => agent.state.state !== 'archived' && agent.state.state !== 'moved')
  const chosen = active ?? found.at(-1)
  if (!chosen) throw new CliFailure(`no agent named ${name}`)
  return chosen
}

const describeMessage = (message: MessageEntity): string => {
  const recipient = message.deliveries[0]
  if (!recipient || message.deliveries.length > 1) return 'sent'
  return recipient.state.state === 'queued' ? `accepted, queued for ${recipient.recipient}` : `accepted, with ${recipient.recipient}`
}

function describeComputer(computer: ComputerEntity): string {
  const agents = computer.agentCount === null ? '' : `, ${computer.agentsRunning} of ${computer.agentCount} agents running`
  const problem = computer.incompatibility === null ? '' : ` (${computer.incompatibility})`
  return `${computer.name}: ${computer.status}, ${computer.trust} trust${agents}${problem}`
}

async function requireComputer(client: Client, name: string | undefined): Promise<ComputerEntity> {
  if (!name) throw new CliFailure('which computer? name it')
  const found = (await client.snapshot()).computers.find((computer) => computer.name === name)
  if (!found) throw new CliFailure(`no computer called ${name}. See: ouro computers`)
  return found
}

async function runComputers(client: Client, args: string[], print: (text: string) => void): Promise<void> {
  const [action, ...rest] = args
  const named = (name: string | undefined) => requireComputer(client, name)
  switch (action) {
    case undefined: {
      const { computers } = await client.snapshot()
      print(computers.length === 0 ? 'no other computers. Add one: ouro computers invite\n' : `${computers.map(describeComputer).join('\n')}\n`)
      return
    }
    case 'invite': {
      const invite = await client.command('create_computer_invite', {})
      print(`Run this on the other computer, within 30 minutes (it works once):\n${invite.command}\n`)
      return
    }
    case 'join': {
      const [address, code] = rest
      if (!address || !code) throw new CliFailure('ouro computers join <address> <code>')
      print(`joined: ${describeComputer((await client.command('join_computer', { address, code })).computer)}\n`)
      return
    }
    case 'trust': {
      const computer = await named(rest[0])
      const trust = rest[1]
      if (trust !== 'full' && trust !== 'limited') throw new CliFailure('ouro computers trust <name> full|limited')
      print(`${describeComputer((await client.command('set_computer_trust', { computerId: computer.id, trust })).computer)}\n`)
      return
    }
    case 'remove': {
      const computer = await named(rest[0])
      await client.command('remove_computer', { computerId: computer.id })
      print(`${computer.name} removed. Nothing on it was deleted.\n`)
      return
    }
    default: throw new CliFailure(`unknown: ouro computers ${action}. See: ouro help`)
  }
}

async function requireRemoteAgent(client: Client, address: string): Promise<RemoteAgentEntity> {
  const found = (await client.snapshot()).remoteAgents.find((agent) => agent.address === address)
  if (!found) throw new CliFailure(`no agent ${address} on the other computers. See: ouro list`)
  return found
}

async function requireGroup(client: Client, handle: string | undefined): Promise<ChatEntity> {
  if (!handle) throw new CliFailure("which group? name it as '#name'")
  const groups = (await client.snapshot()).chats.filter((chat) => chat.kind === 'group')
  const found = groups.find((chat) => chatHandle(chat) === handle.toLowerCase())
  if (!found) throw new CliFailure(`no group ${handle}. The groups: ${groups.map(chatHandle).join(' ') || 'none yet'}`)
  return found
}

const describeGroup = (chat: ChatEntity, me: string): string =>
  `${chat.members.some((member) => member.address === me) ? '*' : ' '} ${chatHandle(chat)}  ${chat.members.map((member) => member.address).join(', ')}`

async function runChats(client: Client, args: string[], me: string, print: (text: string) => void): Promise<void> {
  const [subcommand, ...rest] = args
  switch (subcommand) {
    case undefined: {
      const groups = (await client.snapshot()).chats.filter((chat) => chat.kind === 'group')
      print(groups.length === 0 ? 'no groups yet: ouro chats new <name> <member>...\n' : `${groups.map((chat) => describeGroup(chat, me)).join('\n')}\n`)
      return
    }
    case 'read': {
      const parsed = parseArguments(rest, ['-n'], [])
      const chat = await requireGroup(client, parsed.positionals[0])
      const limit = Number(parsed.flags.get('-n')?.[0] ?? 20)
      const page = await client.call('GET', `/v2/chats/${encodeURIComponent(chat.id)}/messages?limit=${limit}`) as HistoryPage
      print(page.messages.length === 0 ? `nothing in ${chatHandle(chat)} yet\n` : `${page.messages.map((message) => `[${message.from}] ${message.text}`).join('\n')}\n`)
      return
    }
    case 'new': {
      const [title, ...members] = rest
      if (!title || members.length === 0) throw new CliFailure('ouro chats new <name> <member>...')
      print(`${describeGroup((await client.command('create_chat', { title, members })).chat, me)}\n`)
      return
    }
    case 'join': {
      const chat = await requireGroup(client, rest[0])
      print(`${describeGroup((await client.command('add_chat_member', { chatId: chat.id, address: me })).chat, me)}\n`)
      return
    }
    case 'add':
    case 'remove': {
      const chat = await requireGroup(client, rest[0])
      if (!rest[1]) throw new CliFailure(`ouro chats ${subcommand} '#group' <member>`)
      const name = subcommand === 'add' ? 'add_chat_member' : 'remove_chat_member'
      print(`${describeGroup((await client.command(name, { chatId: chat.id, address: rest[1] })).chat, me)}\n`)
      return
    }
    default:
      throw new CliFailure(`no such chats command: ${subcommand}`)
  }
}

function guardianCall(socketPath: string, method: string, path: string, body: object | null): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    outgoing.on('error', reject)
    outgoing.end(body ? JSON.stringify(body) : undefined)
  })
}

interface DeploymentAnswer { id: string; phase: string; reason: string | null; releaseId: string | null; commit: string | null }

const DEPLOY_WAIT_POLL_MS = 500
const DEPLOY_FAILURE_PHASES = ['build_failed', 'verification_failed', 'refused', 'superseded', 'rolled_back', 'rollback_unverified']

async function runDeploy(socketPath: string, reference: string | undefined, requestedBy: string | null, print: (text: string) => void): Promise<void> {
  const started = await guardianCall(socketPath, 'POST', '/deploy', { reference, requestedBy })
  const { id } = started.body as DeploymentAnswer
  let lastPhase = ''
  for (;;) {
    const { body } = await guardianCall(socketPath, 'GET', `/deployments/${id}`, null)
    const deployment = body as DeploymentAnswer
    if (deployment.phase !== lastPhase) {
      lastPhase = deployment.phase
      print(`${deployment.phase}\n`)
    }
    if (deployment.phase === 'live') {
      print(`release ${deployment.releaseId} is live and confirmed healthy (commit ${deployment.commit?.slice(0, 8)})\n`)
      return
    }
    if (DEPLOY_FAILURE_PHASES.includes(deployment.phase)) throw new CliFailure(`${deployment.phase}: ${deployment.reason ?? 'no reason recorded'}`)
    await new Promise((done) => setTimeout(done, DEPLOY_WAIT_POLL_MS))
  }
}

interface FollowingAnswer { remote: string; branch: string }

type FollowCheckAnswer =
  | { kind: 'not_following' }
  | { kind: 'busy' }
  | { kind: 'fetch_failed'; following: FollowingAnswer; error: string }
  | { kind: 'up_to_date'; following: FollowingAnswer; head: string }
  | { kind: 'deploying'; following: FollowingAnswer; head: string; deploymentId: string }
  | { kind: 'failed_before'; following: FollowingAnswer; head: string; phase: string }
  | { kind: 'slow_before'; following: FollowingAnswer; head: string; retryAt: number }

function describeFollowCheck(check: FollowCheckAnswer): string {
  if (check.kind === 'not_following') return 'not following a branch: this machine changes version only by ouro deploy'
  if (check.kind === 'busy') return 'a deploy is under way; the followed branch is checked again after it'
  const branch = `${check.following.remote}/${check.following.branch}`
  if (check.kind === 'fetch_failed') return `following ${branch}, but it can't be fetched now: ${check.error}`
  const head = check.head.slice(0, 8)
  switch (check.kind) {
    case 'up_to_date': return `following ${branch}: up to date at ${head}`
    case 'deploying': return `following ${branch}: deploying ${head} (deployment ${check.deploymentId})`
    case 'failed_before': return `following ${branch}: ${head} ended ${check.phase.replaceAll('_', ' ')} here before, so it waits for a newer commit (ouro deploy ${head} tries it again)`
    case 'slow_before': return `following ${branch}: ${head} didn't start in time once; tried again at ${new Date(check.retryAt).toISOString()}`
  }
}

async function runUpdate(socketPath: string, args: string[], environment: NodeJS.ProcessEnv, print: (text: string) => void): Promise<void> {
  const [action, branch, remote = 'origin'] = args
  if (action === undefined) {
    print(`${describeFollowCheck((await guardianCall(socketPath, 'POST', '/following/check', null)).body as FollowCheckAnswer)}\n`)
    return
  }
  if (action !== 'follow' || !branch) throw new CliFailure('ouro update | ouro update follow <branch> [<remote>] | ouro update follow off')
  // What this machine follows changes its code without anyone reviewing each change: the person decides that, not an agent.
  if (environment.OURO_AGENT_CREDENTIAL) throw new CliFailure(`only the person can choose what this machine follows; ask them to run: ouro update follow ${branch}`)
  const following = branch === 'off' ? { remote: null, branch: null } : { remote, branch }
  const answer = await guardianCall(socketPath, 'PUT', '/following', following)
  if (answer.status !== 200) throw new CliFailure((answer.body as { error: string }).error)
  print(`${describeFollowCheck(answer.body as FollowCheckAnswer)}\n`)
}

const guardianSocketOf = (environment: NodeJS.ProcessEnv): string => {
  const socket = environment.OURO_GUARDIAN_SOCKET
  if (!socket) throw new CliFailure("OURO_GUARDIAN_SOCKET is not set, so this machine isn't running under a guardian")
  return socket
}

function describeGoal(goal: GoalEntity): string {
  const kind = goal.kind.kind === 'open_ended' ? 'open-ended' : goal.kind.kind === 'checked' ? `checked by \`${goal.kind.checkCommand}\`` : 'finishing'
  switch (goal.status.status) {
    case 'active': {
      const next = goal.status.cycleRunning ? 'cycle running' : goal.status.nextCycleAt ? `next cycle ${new Date(goal.status.nextCycleAt).toISOString()}` : 'waiting'
      const waiting = goal.status.waitingFor ? ` (${goal.status.waitingFor.kind.replaceAll('_', ' ')})` : ''
      return `active, ${kind}, cycle ${goal.cycleCount}, ${next}${waiting}, $${goal.costUsd.toFixed(4)}`
    }
    case 'paused': return `paused by ${goal.status.by}${goal.status.reason ? `: ${goal.status.reason}` : ''}`
    case 'complete': return `complete: ${goal.status.summary}`
  }
}

async function runGoal(client: Client, args: string[], environment: NodeJS.ProcessEnv, stdin: () => string, print: (text: string) => void): Promise<void> {
  const parsed = parseArguments(args, ['--check', '--every', '--for'], ['--open-ended'])
  const [action = 'show', ...words] = parsed.positionals
  const targetName = parsed.flags.get('--for')?.[0] ?? environment.OURO_AGENT_NAME
  if (!targetName) throw new CliFailure('whose goal? Add --for <agent>')
  const agent = await requireAgent(client, targetName)
  const show = (goal: GoalEntity) => print(`${agent.name}: ${describeGoal(goal)}\n`)
  switch (action) {
    case 'show': {
      const goal = (await client.snapshot()).goals.find((candidate) => candidate.agentId === agent.id)
      if (!goal) {
        print(`${agent.name} has no goal\n`)
        return
      }
      show(goal)
      print(`\n${goal.text}\n${goal.notes ? `\nNotes:\n${goal.notes}\n` : ''}`)
      return
    }
    case 'set': {
      const check = parsed.flags.get('--check')?.[0]
      const every = parsed.flags.get('--every')?.[0]
      const kind = check ? { kind: 'checked', checkCommand: check } : parsed.switches.has('--open-ended') ? { kind: 'open_ended' } : { kind: 'finishing' }
      const { goal } = await client.command('set_goal', { agentId: agent.id, text: messageText(words, stdin, 'the goal'), kind, intervalSeconds: every ? Number(every) : null })
      return show(goal)
    }
    case 'every': {
      const value = words[0]
      if (!value) throw new CliFailure('how often? ouro goal every <seconds|default>')
      const { goal } = await client.command('set_goal_interval', { agentId: agent.id, intervalSeconds: value === 'default' ? null : Number(value) })
      return show(goal)
    }
    case 'pause': return show((await client.command('pause_goal', { agentId: agent.id, reason: words.length > 0 ? words.join(' ') : null })).goal)
    case 'resume': return show((await client.command('resume_goal', { agentId: agent.id })).goal)
    case 'reopen': return show((await client.command('reopen_goal', { agentId: agent.id })).goal)
    case 'done': return show((await client.command('mark_goal_done', { agentId: agent.id, summary: words.length > 0 ? words.join(' ') : null })).goal)
    case 'clear':
      await client.command('clear_goal', { agentId: agent.id })
      print(`${agent.name}'s goal is cleared; its notes stay\n`)
      return
    default:
      throw new CliFailure(`no such goal action: ${action}. See: ouro help`)
  }
}

/**
 * Exports the committed app and registers it as the next update. Says "published" only when the server has it; anything
 * else leaves the change saved but not shipped, and says why.
 */
async function runPublish(client: Client, args: string[], environment: NodeJS.ProcessEnv, print: (text: string) => void): Promise<void> {
  const parsed = parseArguments(args, ['--app'], [])
  const appDir = parsed.flags.get('--app')?.[0] ?? environment.OURO_APP_SOURCE
  const notShipped = (why: string) => new CliFailure(`not shipped: ${why}. The change is saved in the source but hasn't reached the phone.`)
  if (!appDir) throw notShipped('no app source is configured: pass --app <folder>')
  const register = async (input: RegisterUpdateInput) =>
    await client.call('POST', '/v2/internal/updates', Buffer.from(JSON.stringify(input)), { 'content-type': 'application/json' }) as PublishedApp
  try {
    const published = await publishCommittedApp(appDir, environment.OURO_APP_EXPORT_COMMAND ?? DEFAULT_EXPORT_COMMAND, register, print)
    print(`published update ${published.updateNumber} for app version ${published.runtimeVersion}. Tell the person to tap the banner at the top of the app.\n`)
  } catch (error) {
    if (error instanceof NotPublished) throw notShipped(error.message)
    throw error
  }
}

function describeBase(base: BaseStatus): string {
  if (base.kind === 'not_taking') return 'this machine takes no bases\n'
  const offered = base.offered === null ? 'no newer base is offered' : `base ${base.offered.n} is offered: ${base.offered.notes}`
  const update = base.update.state === 'idle' ? ''
    : base.update.state === 'updating' ? `updating to base ${base.update.n}\n`
      : base.update.state === 'conflict' ? `base ${base.update.n} conflicts in ${base.update.files.join(', ')}${base.update.resolver ? `; ${base.update.resolver} is resolving it` : '; start an agent to merge it with ouro base resolve, or drop it with ouro base drop'}\n`
        : `base ${base.update.n} didn't go in: ${base.update.why}\n`
  return `on base ${base.integrated}; ${offered}\n${update}`
}

async function runBase(client: Client, args: string[], print: (text: string) => void): Promise<void> {
  const [verb, n] = args
  if (verb === undefined) return print(describeBase((await client.snapshot()).server.release.base))
  if (verb === 'take' && n !== undefined && /^[1-9][0-9]*$/.test(n)) return print(describeBase((await client.command('take_base_update', { n: Number(n) })).server.release.base))
  if (verb === 'continue') return print(describeBase((await client.command('continue_base_update', {})).server.release.base))
  if (verb === 'resolve') return print(describeBase((await client.command('resolve_base_update', {})).server.release.base))
  if (verb === 'drop') return print(describeBase((await client.command('drop_base_update', {})).server.release.base))
  throw new CliFailure('usage: ouro base [take <n> | resolve | drop | continue]')
}

export async function runCli(args: string[], environment: NodeJS.ProcessEnv, stdin: () => string, print: (text: string) => void): Promise<void> {
  const [verb, ...rest] = args
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    print(HELP)
    return
  }
  if (verb === 'deploy') {
    return await runDeploy(guardianSocketOf(environment), rest[0], environment.OURO_AGENT_NAME ?? null, print)
  }
  if (verb === 'release-status') {
    print(`${JSON.stringify((await guardianCall(guardianSocketOf(environment), 'GET', '/status', null)).body)}\n`)
    return
  }
  if (verb === 'update') {
    return await runUpdate(guardianSocketOf(environment), rest, environment, print)
  }
  if (verb === 'publish') {
    return await runPublish(new Client(environment), rest, environment, print)
  }
  const client = new Client(environment)

  switch (verb) {
    case 'send': {
      const parsed = parseArguments(rest, ['--file'], ['--fyi'])
      const [to, ...words] = parsed.positionals
      if (!to) throw new CliFailure('send to whom? ouro send <agent|human> "message"')
      const files = parsed.flags.get('--file') ?? []
      const text = files.length > 0 && words.length === 0 ? '' : messageText(words, stdin, 'the message')
      if (to.startsWith('#')) {
        if (parsed.switches.has('--fyi')) throw new CliFailure('a group post calls only the members it @mentions; there is no --fyi for groups')
        const chat = await requireGroup(client, to)
        await client.command('post_to_chat', { chatId: chat.id, text, attachmentIds: await attachmentIds(client, files) })
        print(`posted in ${chatHandle(chat)}\n`)
        return
      }
      if (to === 'all') {
        const { messages } = await client.command('broadcast_message', { text, attachmentIds: await attachmentIds(client, files), wake: parsed.switches.has('--fyi') ? 'fyi' : 'wake' })
        const recipients = messages.flatMap((message) => message.deliveries.map((delivery) => delivery.recipient))
        print(`sent to ${recipients.length > 0 ? recipients.join(', ') : 'nobody (no other running agents)'}\n`)
        return
      }
      const { message } = await client.command('send_message', { to, text, attachmentIds: await attachmentIds(client, files), wake: parsed.switches.has('--fyi') ? 'fyi' : 'wake', answersAskId: null })
      print(`${describeMessage(message)}: to ${to}\n`)
      return
    }
    case 'relay': {
      const parsed = parseArguments(rest, ['--ask'], [])
      const [to, ...words] = parsed.positionals
      if (!to) throw new CliFailure('relay to whom? ouro relay <agent> [--ask <ask-id>] "the person\'s words"')
      const text = messageText(words, stdin, "the person's words")
      const { message } = await client.command('relay_message', { to, text, answersAskId: parsed.flags.get('--ask')?.[0] ?? null })
      print(`${describeMessage(message)}: to ${to}, as ${message.from}'s own words\n`)
      return
    }
    case 'computers': return await runComputers(client, rest, print)
    case 'networks': {
      const snapshot = await client.snapshot()
      const networks = snapshot.server.networks ?? []
      if (networks.length === 0) {
        print('no networks: this server links with computers as before networks. See: ouro computers\n')
        return
      }
      const lines = networks.map((network) => {
        const members = snapshot.computers.filter((computer) => computer.networkId === network.id)
        const named = members.map((computer) => `${computer.name}${computer.visiting ? ' (visiting)' : ''}`).join(', ') || 'no other computers yet'
        return `${network.name}: ${network.kind}, ${network.role === 'home' ? 'home key' : 'extra key'}; ${named}`
      })
      print(`${lines.join('\n')}\n`)
      return
    }
    case 'pull': {
      const parsed = parseArguments(rest, ['--name'], [])
      const address = parsed.positionals[0]
      if (!address) throw new CliFailure('ouro pull <agent@computer> [--name <n>]')
      const remote = await requireRemoteAgent(client, address)
      const { agent } = await client.command('pull_agent', { remoteAgentId: remote.id, name: parsed.flags.get('--name')?.[0] ?? null })
      print(`${agent.name} is a copy of ${address}, paused until started: ouro start-pulled ${agent.name}\n`)
      return
    }
    case 'start-pulled': {
      const agent = await requireAgent(client, rest[0])
      await client.command('start_pulled_agent', { agentId: agent.id })
      print(`${agent.name} may run now\n`)
      return
    }
    case 'push-memory': {
      const parsed = parseArguments(rest, ['--folder'], [])
      const computer = await requireComputer(client, parsed.positionals[0])
      const { notes } = await client.command('push_memory', { computerId: computer.id, folder: parsed.flags.get('--folder')?.[0] ?? null })
      print(`${notes} shared ${notes === 1 ? 'note' : 'notes'} sent to ${computer.name}\n`)
      return
    }
    case 'memory': {
      const parsed = parseArguments(rest, [], ['--hook'])
      if (parsed.positionals[0] !== 'sync') throw new CliFailure('ouro memory sync')
      // As Claude Code's hook after a write: only a write to the memory folder changes anything.
      if (parsed.switches.has('--hook') && !wroteToMemory(stdin(), environment.OURO_MEMORY_DIR)) return
      await client.command('sync_memory', {})
      return
    }
    case 'reply': {
      const parsed = parseArguments(rest, ['--file'], [])
      const files = parsed.flags.get('--file') ?? []
      const text = files.length > 0 && parsed.positionals.length === 0 ? '' : messageText(parsed.positionals, stdin, 'the reply')
      const { message } = await client.command('reply', { text, attachmentIds: await attachmentIds(client, files) })
      print(`${describeMessage(message)}: in chat ${message.chatId}\n`)
      return
    }
    case 'ask': {
      const parsed = parseArguments(rest, ['--choice'], ['--blocked', '--urgent'])
      const [to, ...words] = parsed.positionals
      if (!to) throw new CliFailure('ask whom? ouro ask human "question"')
      const level = parsed.switches.has('--urgent') ? 'urgent' : parsed.switches.has('--blocked') ? 'blocked' : 'waiting'
      const { ask } = await client.command('ask', { to, text: messageText(words, stdin, 'the question'), level, choices: parsed.flags.get('--choice') ?? [] })
      print(`asked (${(ask as AskEntity).level}), ask id ${ask.id}\n`)
      return
    }
    case 'goal':
      return await runGoal(client, rest, environment, stdin, print)
    case 'goals': {
      const snapshot = await client.snapshot()
      const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]))
      const lines = snapshot.goals.map((goal) => `${names.get(goal.agentId) ?? goal.agentId}  ${describeGoal(goal)}  ${goal.text.split('\n')[0]!.slice(0, 80)}`)
      print(lines.length > 0 ? `${lines.join('\n')}\n` : 'no goals\n')
      return
    }
    case 'withdraw-ask': {
      if (!rest[0]) throw new CliFailure('which ask? ouro withdraw-ask <ask-id>')
      await client.command('withdraw_ask', { askId: rest[0] })
      print('withdrawn\n')
      return
    }
    case 'done': {
      const summary = messageText(rest, stdin, 'the summary')
      const { runningHelpers } = await client.command('finish_agent', { summary })
      print('done: your report is sent. A later message reopens you.\n')
      if (runningHelpers.length > 0) {
        print(`warning: your helpers ${runningHelpers.join(', ')} are still running. If their work is no longer needed, tell them to stop (ouro send <name> "stop: call done"); their reports would wait unread.\n`)
      }
      return
    }
    case 'spawn': {
      const parsed = parseArguments(rest, ['--folder', '--model'], [])
      const [name, ...words] = parsed.positionals
      if (!name) throw new CliFailure('spawn what? ouro spawn <new-name> "task"')
      const request = { task: messageText(words, stdin, 'the task'), model: parsed.flags.get('--model')?.[0] ?? null, folder: parsed.flags.get('--folder')?.[0] ?? null }
      const [localName, computerName] = name.split('@')
      if (computerName !== undefined) {
        const { remoteAgent } = await client.command('create_remote_agent', { ...request, name: localName!, computerId: (await requireComputer(client, computerName)).id })
        print(`started ${remoteAgent.address}\n`)
        return
      }
      const { agent } = await client.command('create_agent', { ...request, name })
      print(`started ${agent.name} in ${agent.folder}\n`)
      return
    }
    case 'new': {
      const parsed = parseArguments(rest, ['--name', '--computer', '--folder', '--model'], [])
      const request = { name: parsed.flags.get('--name')?.[0] ?? null, task: messageText(parsed.positionals, stdin, 'the task'), model: parsed.flags.get('--model')?.[0] ?? null, folder: parsed.flags.get('--folder')?.[0] ?? null }
      const computerName = parsed.flags.get('--computer')?.[0]
      if (computerName !== undefined) {
        const { remoteAgent } = await client.command('create_remote_agent', { ...request, computerId: (await requireComputer(client, computerName)).id })
        print(`started ${remoteAgent.address}\n`)
        return
      }
      const { agent } = await client.command('create_agent', request)
      print(`started ${agent.name} in ${agent.folder}\n`)
      return
    }
    case 'chats': return await runChats(client, rest, environment.OURO_AGENT_NAME ?? 'human', print)
    case 'list': {
      const snapshot = await client.snapshot()
      const summaries = new Map(snapshot.summaries.map((summary) => [summary.agentId, summary]))
      const lines = snapshot.agents
        .filter((agent) => agent.state.state !== 'archived' && agent.state.state !== 'moved')
        .map((agent) => {
          const line = `${agent.name}  ${describeDisplay(displayStateOf(agent.state, { reachable: true }))}  waiting ${agent.queuedDeliveries}  ${agent.task.slice(0, 80).replace(/\n/g, ' ')}`
          const summary = summaries.get(agent.id)
          const lately = summary?.live && (!summary.latest || summary.live.at > summary.latest.at) ? summary.live.line : summary?.latest?.line
          return lately ? `${line}\n    lately: ${lately}` : line
        })
      const reachable = new Map(snapshot.computers.map((computer) => [computer.id, computer.status !== 'offline']))
      const remote = snapshot.remoteAgents.map((agent) => {
        const state = agent.details ? describeDisplay(displayStateOf(agent.details.state, { reachable: reachable.get(agent.computerId) ?? false })) : agent.activity
        const line = `${agent.address}  ${state}${agent.details ? `  ${agent.details.task.slice(0, 80).replace(/\n/g, ' ')}` : ''}`
        return agent.details?.summaryLine ? `${line}\n    lately: ${agent.details.summaryLine}` : line
      })
      const all = [...lines, ...remote]
      print(all.length > 0 ? `${all.join('\n')}\n` : 'no agents\n')
      return
    }
    case 'stop':
    case 'interrupt':
    case 'archive':
    case 'unarchive': {
      if (rest[0]?.includes('@')) {
        if (verb === 'unarchive') throw new CliFailure("archived agents aren't shown across computers: unarchive it on its own computer")
        const remote = await requireRemoteAgent(client, rest[0])
        const { remoteAgent } = await client.command('control_remote_agent', { remoteAgentId: remote.id, action: { kind: verb } })
        print(`${remoteAgent.address}: ${remoteAgent.details ? describeDisplay(displayStateOf(remoteAgent.details.state, { reachable: true })) : remoteAgent.activity}\n`)
        return
      }
      const agent = await requireAgent(client, rest[0])
      const command = `${verb}_agent` as 'stop_agent' | 'interrupt_agent' | 'archive_agent' | 'unarchive_agent'
      const result = await client.command(command, { agentId: agent.id })
      print(`${agent.name}: ${describeDisplay(displayStateOf(result.agent.state, { reachable: true }))}\n`)
      return
    }
    case 'merge': {
      const agent = await requireAgent(client, rest[0])
      const { merge } = await client.command('merge_agent_branch', { agentId: agent.id })
      if (merge.kind === 'not_merged') throw new CliFailure(`${merge.branch} was not merged into ${merge.base}: ${merge.why}`)
      print(merge.kind === 'merged' ? `merged ${merge.branch} into ${merge.base} (${merge.how === 'fast_forward' ? 'fast-forward' : 'rebased'})\n` : `${merge.branch} has nothing to merge into ${merge.base}\n`)
      return
    }
    case 'base': return await runBase(client, rest, print)
    case 'set-model': {
      if (!rest[1]) throw new CliFailure('which model? ouro set-model <agent> <model>')
      if (rest[0]?.includes('@')) {
        const remote = await requireRemoteAgent(client, rest[0])
        await client.command('control_remote_agent', { remoteAgentId: remote.id, action: { kind: 'set_model', model: rest[1] } })
        print(`${remote.address} uses ${rest[1]} from its next start, keeping its context\n`)
        return
      }
      const agent = await requireAgent(client, rest[0])
      await client.command('set_agent_model', { agentId: agent.id, model: rest[1] })
      print(`${agent.name} uses ${rest[1]} from its next start, keeping its context\n`)
      return
    }
    case 'move': {
      if (!rest[1]) throw new CliFailure('to which computer? ouro move <agent> <computer>')
      const agent = await requireAgent(client, rest[0])
      const computer = (await client.snapshot()).computers.find((candidate) => candidate.name === rest[1])
      if (!computer) throw new CliFailure(`no computer called ${rest[1]}. See: ouro computers`)
      const { agent: moving } = await client.command('move_agent', { agentId: agent.id, computerId: computer.id })
      const when = moving.state.state === 'moving' ? 'now' : 'at the end of its turn'
      print(`${agent.name} moves to ${computer.name} ${when}; then it is ${agent.name}@${computer.name}, and ${agent.name} here forwards there\n`)
      return
    }
    case 'log': {
      const agent = await requireAgent(client, rest[0])
      print(`${JSON.stringify(await client.call('GET', `/v2/agents/${agent.id}/log`), null, 1)}\n`)
      return
    }
    case 'search': {
      if (rest.length === 0) throw new CliFailure('search for what? ouro search <words>')
      const page = await client.call('GET', `/v2/search?q=${encodeURIComponent(rest.join(' '))}`) as SearchPage
      const lines = page.hits.map((hit) => `${new Date(hit.at).toISOString().slice(0, 16).replace('T', ' ')} [${hit.from}] ${hit.excerpt}`)
      print(`${lines.length > 0 ? lines.join('\n') : 'nothing found'}${page.more ? '\n(more: add words to narrow it)' : ''}\n`)
      return
    }
    case 'why': {
      const agent = await requireAgent(client, rest[0])
      const answer = await client.call('GET', `/v2/agents/${agent.id}/explanation`) as { agent: AgentEntity; transitions: { fromState: string; toState: string; generation: number; cause: string; at: number }[] }
      const lines = answer.transitions.map((transition) => `${new Date(transition.at).toISOString()}  ${transition.fromState} -> ${transition.toState}  (generation ${transition.generation})  ${transition.cause}`)
      print(`${agent.name}: ${describeDisplay(displayStateOf(answer.agent.state, { reachable: true }))}, ${answer.agent.queuedDeliveries} waiting\n${lines.join('\n')}\n`)
      return
    }
    case 'pair': {
      const parsed = parseArguments(rest, ['--invite'], [])
      const result = await client.command('start_pairing', { inviteePersonName: parsed.flags.get('--invite')?.[0] ?? null })
      print(`code: ${result.code}\nlink: ${result.link}\nexpires: ${new Date(result.expiresAt).toISOString()}\n`)
      return
    }
    case 'devices': {
      const snapshot = await client.snapshot()
      const personName = (personId: string) => snapshot.people.find((person) => person.id === personId)?.name ?? personId
      if (rest[0] === undefined) {
        if (snapshot.devices.length === 0) return print('no paired phones (ouro pair)\n')
        const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
        print(snapshot.devices.map((device) => `${device.name}  ${personName(device.personId)}  paired ${minute(device.pairedAt)}  last seen ${device.lastSeenAt === null ? 'never' : minute(device.lastSeenAt)}  (${device.id})\n`).join(''))
        return
      }
      if (rest[0] !== 'revoke' || rest[1] === undefined) throw new CliFailure('usage: ouro devices revoke <device>')
      const wanted = rest[1]
      // A phone's name isn't unique: two can both be "iPhone". Its id always is.
      const named = snapshot.devices.filter((device) => device.id === wanted || device.name === wanted)
      if (named.length === 0) throw new CliFailure(`no paired phone named "${wanted}". See: ouro devices`)
      if (named.length > 1) throw new CliFailure(`${named.length} phones are named "${wanted}": revoke one by its id (${named.map((device) => device.id).join(', ')})`)
      await client.command('revoke_device', { deviceId: named[0]!.id })
      print(`revoked ${named[0]!.name}; its token no longer works\n`)
      return
    }
    case 'identity': {
      print(`${JSON.stringify(await client.call('GET', '/v2/identity'))}\n`)
      return
    }
    default:
      throw new CliFailure(`no such command: ${verb}. See: ouro help`)
  }
}
