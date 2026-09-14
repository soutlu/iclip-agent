import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalUuid, mintUuid } from './uuid'

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

describe('canonicalUuid', () => {
  const canonical = 'e1e53ab6-ec97-4338-943d-06f3c78e3249'

  it.each([
    ['无横线', 'e1e53ab6ec974338943d06f3c78e3249', canonical],
    ['大写', 'E1E53AB6-EC97-4338-943D-06F3C78E3249', canonical],
    ['横线位置不标准', 'e1e5-3ab6ec974338943d06f3c78e3249', canonical],
    ['已经是规范写法', canonical, canonical],
    ['不是 UUID', 'not-a-uuid', null],
    ['长度不够', 'e1e53ab6ec9743', null],
    ['混进了非十六进制字符', 'z1e53ab6ec974338943d06f3c78e3249', null],
  ])('%s', (_name, raw, expected) => {
    expect(canonicalUuid(raw)).toBe(expected)
  })
})
