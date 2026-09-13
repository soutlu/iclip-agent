import { beforeEach, describe, expect, it } from 'vitest'
import {
  draftOf,
  editDraftError,
  editDraftKey,
  emptyEditDraft,
  isEmptyDraft,
  loadEditDrafts,
} from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  artifactPath: 'video_shot.json',
  shotIndex: 1,
  frameNumber: 1,
}
const BASE = 'https://example.com/original.png'
const OTHER = 'https://example.com/result.png'

const store = (drafts: Record<string, FrameEditDraft>) =>
  sessionStorage.setItem(editDraftKey(target), JSON.stringify(drafts))

describe('未提交图片编辑草稿', () => {
  beforeEach(() => sessionStorage.clear())

  it('每张底图各存各的，互不串台', () => {
    const onBase: FrameEditDraft = {
      annotations: [],
      instructions: [{ kind: 'text', text: '改成蓝色' }],
      references: [{ id: 'base', kind: 'image', url: BASE, label: '编辑底图' }],
    }
    store({ [BASE]: onBase })
    const drafts = loadEditDrafts(target)

    expect(draftOf(drafts, BASE)).toEqual(onBase)
    expect(draftOf(drafts, OTHER)).toEqual(emptyEditDraft(OTHER))
  })

  it('空草稿反复算出同一份，底图芯片的指向不会变', () => {
    expect(emptyEditDraft(BASE)).toEqual(emptyEditDraft(BASE))
    expect(isEmptyDraft(emptyEditDraft(BASE))).toBe(true)
    expect(
      isEmptyDraft({ ...emptyEditDraft(BASE), instructions: [{ kind: 'text', text: '改' }] }),
    ).toBe(false)
  })

  it('没有选图的草稿恢复时带回底图并保留修改要求', () => {
    store({
      [BASE]: {
        annotations: [],
        instructions: [{ kind: 'text', text: '改成蓝色' }],
        references: [],
      },
    })

    const restored = draftOf(loadEditDrafts(target), BASE)

    expect(restored.references).toEqual([expect.objectContaining({ url: BASE, kind: 'image' })])
    expect(restored.instructions).toEqual([{ kind: 'text', text: '改成蓝色' }])
    expect(editDraftError(restored)).toBeNull()
  })

  it('读坏的草稿抛出来，由调用方决定怎么提示', () => {
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: { annotations: 1 } }))
    expect(() => loadEditDrafts(target)).toThrow()
  })

  it('超长修改要求完整恢复，提交前提示缩短而不丢失草稿', () => {
    const draft: FrameEditDraft = {
      annotations: [],
      instructions: [{ kind: 'text', text: '长'.repeat(5000) }],
      references: [{ id: 'base', kind: 'image', url: BASE, label: '编辑底图' }],
    }
    store({ [BASE]: draft })

    const restored = draftOf(loadEditDrafts(target), BASE)

    expect(restored).toEqual(draft)
    expect(editDraftError(restored)).not.toBeNull()
    expect(
      editDraftError({ ...restored, instructions: [{ kind: 'text', text: '改成蓝色' }] }),
    ).toBeNull()
  })

  it('已移除图片的引用保留身份并阻止提交，重新关联后恢复可提交', () => {
    const reference = {
      id: 'other',
      kind: 'image' as const,
      url: 'https://example.com/other.png',
      label: '衣服',
    }
    const draft: FrameEditDraft = {
      annotations: [],
      instructions: [
        { kind: 'text', text: '换成' },
        { kind: 'referenceImage', id: reference.id },
      ],
      references: [{ id: 'base', kind: 'image', url: BASE, label: '编辑底图' }],
    }
    store({ [BASE]: draft })

    const restored = draftOf(loadEditDrafts(target), BASE)

    expect(restored.instructions).toEqual(draft.instructions)
    expect(editDraftError(restored)).not.toBeNull()
    expect(
      editDraftError({ ...restored, references: [...restored.references, reference] }),
    ).toBeNull()
  })
})
