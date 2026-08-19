import type { ComposerFileAttachment } from '@/shared/composer/composer.types'

export const COMPOSER_MEDIA_STACK_CARD_WIDTH = 48
export const COMPOSER_MEDIA_STACK_CARD_HEIGHT = 85
export const COMPOSER_MEDIA_STACK_GAP = 4
export const COMPOSER_MEDIA_STACK_POINTER_ACTIVATION_DISTANCE = 8

const STACK_ROTATION_MIN = -18
const STACK_ROTATION_MAX = 8
const STACK_ROTATION_STEP = 2

const hashString = (value: string) => {
  let hash = 0

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return hash
}

export const getComposerMediaStackRotation = (attachmentId: string) => {
  const stepCount = Math.floor((STACK_ROTATION_MAX - STACK_ROTATION_MIN) / STACK_ROTATION_STEP) + 1
  const rotation = STACK_ROTATION_MIN + (hashString(attachmentId) % stepCount) * STACK_ROTATION_STEP

  return `${rotation}deg`
}

export const reorderComposerAttachments = (
  attachments: ComposerFileAttachment[],
  activeId: string,
  overId: string,
) => {
  if (activeId === overId) {
    return attachments
  }

  const activeIndex = attachments.findIndex((attachment) => attachment.id === activeId)
  const overIndex = attachments.findIndex((attachment) => attachment.id === overId)

  if (activeIndex < 0 || overIndex < 0) {
    return attachments
  }

  const nextAttachments = [...attachments]
  const [movedAttachment] = nextAttachments.splice(activeIndex, 1)

  if (!movedAttachment) {
    return attachments
  }

  nextAttachments.splice(overIndex, 0, movedAttachment)
  return nextAttachments
}
