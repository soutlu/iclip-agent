import { describe, expect, it } from 'vitest'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { parsePromptContent, serializePromptContent } from './prompt-clipboard'

const content: PromptContentPart[] = [
  { text: '先看这张图：', type: 'text' },
  {
    source: { kind: 'url', url: 'https://bkt.oss-cn-hangzhou.aliyuncs.com/u/S6-1.jpg' },
    type: 'image',
  },
  {
    source: { kind: 'url', url: 'https://bkt.oss-cn-hangzhou.aliyuncs.com/u/demo.mp4' },
    type: 'video',
  },
]

describe('prompt-clipboard', () => {
  it('复制出的文本解析回同一份 content', () => {
    expect(parsePromptContent(serializePromptContent(content))).toEqual(content)
  })

  it.each([
    ['普通文字', '明天上午开会'],
    ['空数组', '[]'],
    ['单个对象不是数组', '{"type":"text","text":"x"}'],
    ['没写 type', '[{"text":"x"}]'],
    ['媒体来源不是公网地址', '[{"type":"image","source":{"kind":"file","fileId":"f1"}}]'],
    ['媒体地址为空', '[{"type":"image","source":{"kind":"url","url":""}}]'],
    [
      '其中一项不认识',
      '[{"type":"text","text":"x"},{"type":"audio","source":{"kind":"url","url":"u"}}]',
    ],
  ])('%s：不认，交还调用方当普通文字', (_case, text) => {
    expect(parsePromptContent(text)).toBeNull()
  })
})
