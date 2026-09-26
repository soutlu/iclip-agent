import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

const withClipboard = (value: unknown) => {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    withClipboard(undefined)
  })

  it('has navigator.clipboard: writes through it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard({ writeText })
    await copyText('分镜 3')
    expect(writeText).toHaveBeenCalledWith('分镜 3')
  })

  it('no navigator.clipboard (plain HTTP): copies via execCommand and cleans up', async () => {
    withClipboard(undefined)
    let copied: string | undefined
    // 在复制那一刻读隐藏文本框的选区，即 execCommand 实际会复制的内容。
    const execCommand = vi.fn(() => {
      const holder = document.querySelector('textarea')
      copied = holder?.value.slice(holder.selectionStart, holder.selectionEnd)
      return true
    })
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    await copyText('分镜 3')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copied).toBe('分镜 3')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('execCommand refuses: throws and cleans up', async () => {
    withClipboard(undefined)
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
    await expect(copyText('x')).rejects.toThrow('复制')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
