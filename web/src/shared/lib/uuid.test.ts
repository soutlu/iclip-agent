import { afterEach, describe, expect, it, vi } from 'vitest'
import { mintUuid } from './uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const nativeRandomUUID = crypto.randomUUID

const withRandomUUID = (value: unknown) => {
  Object.defineProperty(crypto, 'randomUUID', { value, configurable: true, writable: true })
}

describe('mintUuid', () => {
  afterEach(() => {
    withRandomUUID(nativeRandomUUID)
    vi.restoreAllMocks()
  })

  it('has randomUUID: uses it', () => {
    const spy = vi.spyOn(crypto, 'randomUUID')
    expect(mintUuid()).toMatch(UUID_V4)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('no randomUUID (plain HTTP): still mints distinct v4 uuids', () => {
    withRandomUUID(undefined)
    const minted = new Set(Array.from({ length: 50 }, mintUuid))
    expect(minted.size).toBe(50)
    for (const id of minted) expect(id).toMatch(UUID_V4)
  })
})
