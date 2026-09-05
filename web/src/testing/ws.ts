/** 通过 createSocket 注入假连接，避免 mock 同仓模块。 */

export class FakeSocket {
  readyState = 1
  sent: string[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  frames(): Array<{ type: string; id?: string; payload?: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string })
  }
}

export const SERVER_HELLO = {
  payload: { heartbeat_ms: 10_000, protocol_version: 2, ws_connection_id: 'w1' },
  type: 'server_hello',
}
