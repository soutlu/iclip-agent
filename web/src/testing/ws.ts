/**
 * 测试用的假 WebSocket。同仓模块不许 `vi.mock`，连接实现由 `createSocket` 换掉。
 */

/** 一条假连接：记下发出去的帧，也能往回灌帧。 */
export class FakeSocket {
  readyState = 1
  /** 客户端发出去的原始帧。 */
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

  /** 服务端发来一帧。 */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** 发出去的那些帧，解析好的。 */
  frames(): Array<{ type: string; id?: string; payload?: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string })
  }
}

/** 服务端握手那一帧。心跳 10 秒即这台服务端的值。 */
export const SERVER_HELLO = {
  payload: { heartbeat_ms: 10_000, protocol_version: 2, ws_connection_id: 'w1' },
  type: 'server_hello',
}
