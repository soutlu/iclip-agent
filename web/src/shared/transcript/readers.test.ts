import { describe, expect, it } from 'vitest'
import { FakeSocket, SERVER_HELLO } from '@/testing/ws'
import { TranscriptConnection } from './connection'
import { TranscriptReaders } from './readers'

const setup = () => {
  const socket = new FakeSocket()
  const connection = new TranscriptConnection({
    createSocket: () => socket as unknown as WebSocket,
    url: 'ws://test/api/ws',
  })
  connection.connect()
  socket.deliver(SERVER_HELLO)
  return { readers: new TranscriptReaders(connection), socket }
}

const subscribes = (socket: FakeSocket) =>
  socket.frames().filter((frame) => frame.type === 'subscribe_v2').length

describe('TranscriptReaders', () => {
  it('同一段流拿到同一个读取器，不同 agent 各一个', () => {
    const { readers } = setup()

    expect(readers.get('c1')).toBe(readers.get('c1', 'main'))
    expect(readers.get('c1', 'run-child')).not.toBe(readers.get('c1'))
    expect(readers.get('c2')).not.toBe(readers.get('c1'))
  })

  it('两个持有者只订一次；最后一个放手才退订，放两次不算两次', () => {
    const { readers, socket } = setup()
    const reader = readers.get('c1')

    const releaseFirst = readers.retain(reader)
    const releaseSecond = readers.retain(reader)
    expect(subscribes(socket)).toBe(1)

    releaseFirst()
    releaseFirst()
    expect(socket.frames().some((frame) => frame.type === 'unsubscribe_v2')).toBe(false)

    releaseSecond()
    expect(socket.frames().some((frame) => frame.type === 'unsubscribe_v2')).toBe(true)
  })

  it('全放手之后再 retain 同一个实例，重新订上', () => {
    const { readers, socket } = setup()
    const reader = readers.get('c1')

    readers.retain(reader)()
    readers.retain(reader)

    expect(subscribes(socket)).toBe(2)
    expect(readers.get('c1')).toBe(reader)
  })
})
