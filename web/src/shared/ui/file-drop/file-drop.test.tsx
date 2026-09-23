import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useFileDropTarget, useWindowFileDrop } from './file-drop'

type HarnessProps = {
  blocked?: boolean
  onFiles?: (files: File[]) => void
  onDirectory?: () => void
  onFallbackFiles?: (files: File[]) => void
}

/** 与真实页面同构：一个局部拖放区，外加聊天框那样挂在 window 上的兜底接收者。 */
function DropPage({
  blocked = false,
  onFiles = () => {},
  onDirectory = () => {},
  onFallbackFiles = () => {},
}: HarnessProps) {
  const zone = useFileDropTarget({ blocked, onDirectory, onFiles })
  const composerRef = useRef<HTMLDivElement>(null)
  const fallbackOver = useWindowFileDrop({
    enabled: true,
    onFiles: onFallbackFiles,
    ownRef: composerRef,
  })
  return (
    <>
      <div aria-label="拖放区" role="group" {...zone.dragHandlers}>
        <button type="button">已有素材</button>
        {zone.dragOver ? <p>松开添加素材</p> : null}
      </div>
      <div aria-label="聊天框" ref={composerRef} role="group" />
      {fallbackOver ? <p>松开鼠标添加附件</p> : null}
    </>
  )
}

const image = new File(['png'], '商品.png', { type: 'image/png' })

const fileDrag = (entries: { file: File; directory?: boolean }[] = [{ file: image }]) => ({
  dropEffect: '',
  files: entries.map((entry) => entry.file),
  items: entries.map((entry) => ({
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: entry.directory === true }),
  })),
  types: ['Files'],
})

const zone = () => screen.getByRole('group', { name: '拖放区' })

describe('useFileDropTarget', () => {
  it('子元素之间进出不收起提示，全部离开才收起；经过时标成可复制', () => {
    render(<DropPage />)
    const child = screen.getByRole('button', { name: '已有素材' })

    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragEnter(child, { dataTransfer: fileDrag() })
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    expect(screen.getByText('松开添加素材')).toBeInTheDocument()

    const dataTransfer = fileDrag()
    fireEvent.dragOver(child, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')

    fireEvent.dragLeave(child, { dataTransfer: fileDrag() })
    expect(screen.queryByText('松开添加素材')).not.toBeInTheDocument()
  })

  it('落下的文件交给 onFiles，提示收起', () => {
    const onFiles = vi.fn()
    render(<DropPage onFiles={onFiles} />)

    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    fireEvent.drop(zone(), { dataTransfer: fileDrag() })

    expect(onFiles).toHaveBeenCalledWith([image])
    expect(screen.queryByText('松开添加素材')).not.toBeInTheDocument()
  })

  it('含文件夹整批拒收：只调 onDirectory', () => {
    const onFiles = vi.fn()
    const onDirectory = vi.fn()
    render(<DropPage onDirectory={onDirectory} onFiles={onFiles} />)

    fireEvent.drop(zone(), {
      dataTransfer: fileDrag([{ file: image }, { directory: true, file: new File([], '素材夹') }]),
    })

    expect(onDirectory).toHaveBeenCalledTimes(1)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('锁定时仍接管文件，但标成禁止落点、不亮提示、落下不回调', () => {
    const onFiles = vi.fn()
    render(<DropPage blocked onFiles={onFiles} />)

    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    const dataTransfer = fileDrag()
    fireEvent.dragOver(zone(), { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    expect(screen.queryByText('松开添加素材')).not.toBeInTheDocument()

    const drop = createEvent.drop(zone(), { dataTransfer: fileDrag() })
    fireEvent(zone(), drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('页内元素、文字的拖动不碰：不 preventDefault、不亮提示', () => {
    render(<DropPage />)
    const dataTransfer = { dropEffect: '', types: ['text/plain'] }

    fireEvent.dragEnter(zone(), { dataTransfer })
    const over = createEvent.dragOver(zone(), { dataTransfer })
    fireEvent(zone(), over)

    expect(over.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('')
    expect(screen.queryByText('松开添加素材')).not.toBeInTheDocument()
  })
})

describe('接管约定：局部拖放区 preventDefault 并保留冒泡，window 兜底只收没被接管的', () => {
  it('落在拖放区：兜底接收者不亮遮罩、不收文件', () => {
    const onFiles = vi.fn()
    const onFallbackFiles = vi.fn()
    render(<DropPage onFallbackFiles={onFallbackFiles} onFiles={onFiles} />)

    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragOver(zone(), { dataTransfer: fileDrag() })
    expect(screen.queryByText('松开鼠标添加附件')).not.toBeInTheDocument()
    fireEvent.drop(zone(), { dataTransfer: fileDrag() })

    expect(onFiles).toHaveBeenCalledWith([image])
    expect(onFallbackFiles).not.toHaveBeenCalled()
  })

  it('落在别处：兜底接收者亮遮罩并收下文件，文件夹滤掉', () => {
    const onFallbackFiles = vi.fn()
    render(<DropPage onFallbackFiles={onFallbackFiles} />)

    fireEvent.dragEnter(document.body, { dataTransfer: fileDrag() })
    expect(screen.getByText('松开鼠标添加附件')).toBeInTheDocument()
    fireEvent.drop(document.body, {
      dataTransfer: fileDrag([{ file: image }, { directory: true, file: new File([], '素材夹') }]),
    })

    expect(onFallbackFiles).toHaveBeenCalledWith([image])
    expect(screen.queryByText('松开鼠标添加附件')).not.toBeInTheDocument()
  })
})
