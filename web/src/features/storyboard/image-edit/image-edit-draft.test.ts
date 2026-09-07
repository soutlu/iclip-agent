import { beforeEach, describe, expect, it } from 'vitest'
import { editDraftError, editDraftKey, loadEditDraft } from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  artifactPath: 'video_shot.json',
  shotIndex: 1,
  frameNumber: 1,
  sourceUrl: 'https://example.com/original.png',
}

describe('未提交图片编辑草稿', () => {
  beforeEach(() => sessionStorage.clear())

  it('超长修改要求完整恢复，提交前提示缩短而不丢失草稿', () => {
    const draft: FrameEditDraft = {
      annotations: [],
      instructions: [{ kind: 'text', text: '长'.repeat(5000) }],
      references: [{ id: 'original', kind: 'image', url: target.sourceUrl, label: '原图' }],
    }
    sessionStorage.setItem(editDraftKey(target), JSON.stringify(draft))

    const restored = loadEditDraft(target)

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
      references: [{ id: 'original', kind: 'image', url: target.sourceUrl, label: '原图' }],
    }
    sessionStorage.setItem(editDraftKey(target), JSON.stringify(draft))

    const restored = loadEditDraft(target)

    expect(restored.instructions).toEqual(draft.instructions)
    expect(editDraftError(restored)).not.toBeNull()
    expect(
      editDraftError({ ...restored, references: [...restored.references, reference] }),
    ).toBeNull()
  })
})
