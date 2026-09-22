import { describe, expect, it } from 'vitest'
import { drainPages } from './paging'

/** 按脚本逐页作答，同时记下每次收到的令牌。 */
const scripted = <Item, Token>(pages: readonly { items: Item[]; next: Token | null }[]) => {
  const tokens: (Token | undefined)[] = []
  let index = 0
  const fetchPage = (token: Token | undefined) => {
    tokens.push(token)
    const page = pages[index]
    index += 1
    if (page === undefined) throw new Error('多取了一页')
    return Promise.resolve(page)
  }
  return { fetchPage, tokens }
}

describe('drainPages', () => {
  it('按页序拼接所有条目，首页令牌为 undefined，其后带上一页给的令牌', async () => {
    const { fetchPage, tokens } = scripted<string, string>([
      { items: ['a', 'b'], next: 'c1' },
      { items: ['c'], next: 'c2' },
      { items: ['d'], next: null },
    ])

    await expect(drainPages(fetchPage)).resolves.toEqual(['a', 'b', 'c', 'd'])
    expect(tokens).toEqual([undefined, 'c1', 'c2'])
  })

  it('首页即宣告没有下一页时只取一次', async () => {
    const { fetchPage, tokens } = scripted<number, number>([{ items: [1, 2], next: null }])

    await expect(drainPages(fetchPage)).resolves.toEqual([1, 2])
    expect(tokens).toEqual([undefined])
  })

  it('首页为空也照样按令牌继续翻，空页不提前结束', async () => {
    const { fetchPage, tokens } = scripted<number, number>([
      { items: [], next: 2 },
      { items: [7], next: null },
    ])

    await expect(drainPages(fetchPage)).resolves.toEqual([7])
    expect(tokens).toEqual([undefined, 2])
  })

  it('任一页失败整体抛出，不返回已取到的部分', async () => {
    const failure = new Error('第二页读取失败')
    const fetchPage = (token: string | undefined) =>
      token === undefined ? Promise.resolve({ items: ['a'], next: 'c1' }) : Promise.reject(failure)

    await expect(drainPages<string, string>(fetchPage)).rejects.toBe(failure)
  })
})
