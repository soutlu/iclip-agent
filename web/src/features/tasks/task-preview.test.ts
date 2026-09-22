import { describe, expect, it } from 'vitest'
import { taskPreviewOf } from './task-preview'
import type { Task } from './tasks.api'

const product = (styleNo: string, imageUrls: string[]) => ({
  style_no: styleNo,
  name: '',
  brand: '',
  category: '',
  color_name: '',
  image_oss_urls: imageUrls,
})

const taskWith = (products: ReturnType<typeof product>[]): Task =>
  ({
    title: '夏季上新',
    inputs: {
      creative_requirement: '用自然光展示亚麻衬衫的质感',
      products,
      reference_image_oss_urls: {
        model: ['https://example.com/model.jpg'],
        outfit: [],
        prop: [],
      },
    },
  }) as unknown as Task

describe('taskPreviewOf', () => {
  it('封面取第一款有商品图的首图', () => {
    const preview = taskPreviewOf(
      taskWith([
        product('A', []),
        product('B', ['https://example.com/b1.jpg', 'https://example.com/b2.jpg']),
        product('C', ['https://example.com/c1.jpg']),
      ]),
    )

    expect(preview).toEqual({
      title: '夏季上新',
      requirement: '用自然光展示亚麻衬衫的质感',
      imageUrl: 'https://example.com/b1.jpg',
    })
  })

  it('没有商品图就没有封面，不用参考图替代', () => {
    expect(taskPreviewOf(taskWith([product('A', [])])).imageUrl).toBeNull()
    expect(taskPreviewOf(taskWith([])).imageUrl).toBeNull()
  })

  it('空白 URL 不算商品图', () => {
    const preview = taskPreviewOf(
      taskWith([product('A', ['   ']), product('B', ['https://example.com/b1.jpg'])]),
    )

    expect(preview.imageUrl).toBe('https://example.com/b1.jpg')
  })
})
