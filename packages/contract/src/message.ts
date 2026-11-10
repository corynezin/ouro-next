// A message has one identity (`id`), one delivery per recipient agent, and many attempts per delivery.
// Existing at all means accepted: the row is committed before the sender gets a success.
import { z } from 'zod'
import { Address } from './address.ts'

/** Why a turn that took a message ended without finishing it. Retrying the same message can't help. */
export const TurnFailure = z.discriminatedUnion('kind', [
  /** The model declined the input, such as a safeguards flag. The provider's own words are kept. */
  z.object({ kind: z.literal('model_refused'), providerMessage: z.string() }),
  /** The agent kept crashing with this message in its turn, until automatic retries stopped. */
  z.object({ kind: z.literal('gave_up'), why: z.string() }),
])
export type TurnFailure = z.infer<typeof TurnFailure>

/** The same words everywhere a failed turn is explained: bubbles, status bars, the CLI. */
export function turnFailureText(failure: TurnFailure): string {
  switch (failure.kind) {
    case 'model_refused': return `the model refused it: ${failure.providerMessage}`
    case 'gave_up': return `it kept failing, so retries stopped: ${failure.why}`
  }
}

export const DeliveryState = z.discriminatedUnion('state', [
  /** Waiting for the recipient. `possiblySeen`: an earlier attempt's turn never finished, so its actions can repeat. */
  z.object({ state: z.literal('queued'), since: z.number().int(), possiblySeen: z.boolean() }),
  /** Given to the agent's runner in this turn; the model hasn't taken it in yet, as when it arrives mid-turn. */
  z.object({ state: z.literal('handed_to_runner'), since: z.number().int(), turnId: z.string(), attemptId: z.string(), possiblySeen: z.boolean() }),
  /** In the model's conversation: `since` is when the runner saw it enter, at a turn's start or a boundary within one. */
  z.object({ state: z.literal('taken_in'), since: z.number().int(), turnId: z.string(), attemptId: z.string(), possiblySeen: z.boolean() }),
  z.object({ state: z.literal('completed'), at: z.number().int(), turnId: z.string(), outcome: z.enum(['turn_finished', 'turn_interrupted']) }),
  /** Permanently refused, such as a recipient archived while it was still queued. */
  z.object({ state: z.literal('undeliverable'), at: z.number().int(), reason: z.string() }),
  /** Its recipient moved to another computer before taking it, and it went along, to `to`. */
  z.object({ state: z.literal('forwarded'), at: z.number().int(), to: Address }),
  /** It reached the model, and its turn failed in a way a retry can't fix. Distinct from never reaching the agent. */
  z.object({ state: z.literal('failed'), at: z.number().int(), turnId: z.string(), failure: TurnFailure }),
])
export type DeliveryState = z.infer<typeof DeliveryState>

/** A recipient on another of the person's computers: this machine's part ends when that machine has the message. */
export const RemoteDeliveryState = z.discriminatedUnion('state', [
  /** Waiting its turn for that machine, in order, retried until it answers. */
  z.object({ state: z.literal('queued'), since: z.number().int(), attempts: z.number().int().nonnegative() }),
  /** That machine has it; its own delivery to the recipient goes on there. */
  z.object({ state: z.literal('accepted'), at: z.number().int() }),
  /** That machine refused it for good, such as no agent of that name, or the computer was removed. */
  z.object({ state: z.literal('undeliverable'), at: z.number().int(), reason: z.string() }),
])
export type RemoteDeliveryState = z.infer<typeof RemoteDeliveryState>

export const RemoteDelivery = z.object({ recipient: Address, state: RemoteDeliveryState })
export type RemoteDelivery = z.infer<typeof RemoteDelivery>

export const DeliveryWake = z.enum(['wake', 'fyi'])
export type DeliveryWake = z.infer<typeof DeliveryWake>

export const Delivery = z.object({
  recipient: Address,
  /** The recipient at the time of sending; a name can later be reused by another agent. */
  recipientAgentId: z.string(),
  wake: DeliveryWake,
  state: DeliveryState,
})
export type Delivery = z.infer<typeof Delivery>

export const MessagePurpose = z.enum([
  'message',
  /** The task an agent was started with. */
  'task',
  'done_report',
  /** From the system rather than a person or agent: who was resumed, a helper's crash, a hold notice. */
  'system_notice',
  'reply_reminder',
  /** A goal cycle: the system asking the agent to continue its goal. */
  'goal_cycle',
])
export type MessagePurpose = z.infer<typeof MessagePurpose>

export const AttachmentRef = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
})
export type AttachmentRef = z.infer<typeof AttachmentRef>

export const MessageEntity = z.object({
  id: z.string(),
  /** Increases across all messages on this server. Order and history paging use this, never `at`. */
  seq: z.number().int().positive(),
  chatId: z.string(),
  from: Address,
  at: z.number().int(),
  text: z.string(),
  attachments: z.array(AttachmentRef),
  purpose: MessagePurpose,
  /** The idempotency key of the send that made it, so the sender's outbox can match it even if the stream beats the response. */
  clientKey: z.string().nullable(),
  /** The ask this message posed, so its choices can show on this bubble. */
  posesAskId: z.string().nullable(),
  /** The ask this message answers, when it answers only that one. */
  answersAskId: z.string().nullable(),
  /** The agent that carried these words of the person's on their behalf (the master agent's relay). Null when sent directly. */
  relayedBy: Address.nullable(),
  deliveries: z.array(Delivery),
  /** Recipients on other machines, as far as this machine knows. */
  remoteDeliveries: z.array(RemoteDelivery),
})
export type MessageEntity = z.infer<typeof MessageEntity>

function remoteReceiptOf(delivery: RemoteDelivery | undefined): MessageReceipt {
  switch (delivery?.state.state) {
    case undefined: return 'sent'
    case 'queued': return 'queued'
    case 'accepted': return 'delivered'
    case 'undeliverable': return 'undeliverable'
  }
}

export type MessageReceipt = 'sent' | 'queued' | 'delivered' | 'read' | 'undeliverable' | 'failed'

/** What a sender's bubble claims about one recipient. "sent" is a committed message with no agent recipient to track. */
export function receiptOf(message: Pick<MessageEntity, 'at' | 'deliveries' | 'remoteDeliveries'>, recipientLastOutputAt: number | null): MessageReceipt {
  const delivery = message.deliveries[0]
  if (!delivery) return remoteReceiptOf(message.remoteDeliveries[0])
  switch (delivery.state.state) {
    case 'queued':
    case 'handed_to_runner':
      return 'queued'
    case 'undeliverable': return 'undeliverable'
    case 'failed': return 'failed'
    // It went on to the recipient's new computer, which isn't tracked from here.
    case 'forwarded': return 'sent'
    case 'taken_in':
    case 'completed':
      return recipientLastOutputAt !== null && recipientLastOutputAt >= message.at ? 'read' : 'delivered'
  }
}
