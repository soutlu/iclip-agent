import { createStableReferenceMention, PlainTextStarterKit } from '@/shared/editor'

export const MEDIA_REFERENCE_NODE_NAME = 'mediaReference'

export const MediaReferenceMention = createStableReferenceMention(MEDIA_REFERENCE_NODE_NAME)

export const MediaComposerStarterKit = PlainTextStarterKit

export const MEDIA_COMPOSER_SCHEMA_EXTENSIONS = [MediaComposerStarterKit, MediaReferenceMention]
