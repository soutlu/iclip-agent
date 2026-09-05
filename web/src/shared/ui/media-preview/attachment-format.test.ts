import { describe, expect, it } from 'vitest'
import { ellipsizeAttachmentName, formatAttachmentSize } from './attachment-format'

describe('formatAttachmentSize', () => {
  it('不足 1KB 原样给字节数', () => {
    expect(formatAttachmentSize(0)).toBe('0 B')
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(1023)).toBe('1023 B')
  })

  it('KB 四舍五入取整', () => {
    expect(formatAttachmentSize(1024)).toBe('1 KB')
    expect(formatAttachmentSize(1536)).toBe('2 KB')
    expect(formatAttachmentSize(4608)).toBe('5 KB')
  })

  it('MB 保留一位小数', () => {
    expect(formatAttachmentSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatAttachmentSize(Math.round(1.5 * 1024 * 1024))).toBe('1.5 MB')
  })
})

describe('ellipsizeAttachmentName', () => {
  it('不超过 32 个 grapheme 原样返回', () => {
    expect(ellipsizeAttachmentName('截图.png')).toBe('截图.png')
    expect(ellipsizeAttachmentName('a'.repeat(32))).toBe('a'.repeat(32))
  })

  it('超长时保留扩展名中间省略', () => {
    const name = `${'图'.repeat(40)}.png`
    const result = ellipsizeAttachmentName(name)
    // 扩展名与额外四字占八个 grapheme，头部保留 23，总长含省略号为 32。
    expect(result).toBe(`${'图'.repeat(23)}…${'图'.repeat(4)}.png`)
    expect([...result]).toHaveLength(32)
  })

  it('扩展名太长留不出头时退化成头部省略', () => {
    const name = `x.${'e'.repeat(40)}`
    expect(ellipsizeAttachmentName(name)).toBe(`x.${'e'.repeat(29)}…`)
  })

  it('emoji 组合字符算一个 grapheme，不劈开', () => {
    const name = `${'👍🏽'.repeat(40)}.webp`
    const result = ellipsizeAttachmentName(name)
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
    expect([...segmenter.segment(result)]).toHaveLength(32)
    expect(result.endsWith('.webp')).toBe(true)
    expect(result).toContain('…')
  })
})
