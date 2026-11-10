// Who a group post calls by name. Pure: the caller supplies each member's names.

/** A member of a group and every way it can be called: an agent by `@name` or `@name@machine`, a person by address or name. */
export interface MentionableMember {
  address: string
  names: string[]
}

const MENTION = /@([\w.-]+(?:@[\w.-]+)?)/g

/** The members a text calls by name. `@human` calls every person. */
export function mentionedMembers(text: string, members: MentionableMember[]): Set<string> {
  const called = new Set([...text.matchAll(MENTION)].map((match) => match[1]!.toLowerCase().replace(/[.-]+$/, '')))
  return new Set(members.filter((member) => member.names.some((name) => called.has(name.toLowerCase()))).map((member) => member.address))
}

/** The names a person answers to in a group. */
export function personNames(person: { address: string; name: string }): string[] {
  return [person.address, person.name, 'human']
}

export function agentNames(agentName: string, machineName: string): string[] {
  return [agentName, `${agentName}@${machineName}`]
}
