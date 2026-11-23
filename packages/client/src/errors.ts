/** A gateway call, a pairing or a relay stream that failed, with a code callers can branch on. */
export class GatewayError extends Error {
  constructor(public code: string, message: string, public data?: unknown) { super(message); this.name = 'GatewayError'; }
}
