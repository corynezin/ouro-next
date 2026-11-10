import { httpStatusOfError } from '@ouro/contract'
import type { ApiError, ErrorCode } from '@ouro/contract'

const RETRYABLE: readonly ErrorCode[] = ['host_hold_refused', 'server_starting', 'peer_unreachable', 'provider_unreachable', 'internal']

/** A refusal the API reports as such. Anything else thrown is a bug and reads as `internal`. */
export class CommandRefused extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, retryable: RETRYABLE.includes(this.code) }
  }

  get httpStatus(): number {
    return httpStatusOfError[this.code]
  }
}
