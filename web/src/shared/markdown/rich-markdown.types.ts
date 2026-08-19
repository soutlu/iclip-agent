export type RichMarkdownRendererVariant = 'canvas-preview' | 'expanded-preview'

export interface RichMarkdownRendererProps {
  className?: string
  identity: string
  markdown: string
  variant?: RichMarkdownRendererVariant
}
