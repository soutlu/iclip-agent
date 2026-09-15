import { useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSurface,
  MenuTrigger,
} from '@/shared/ui/menu'
import { durationOf, type EditorVersion } from './editor-model'
import './editor-version-menu.css'

type EditorVersionMenuProps = {
  version: EditorVersion
  versions: readonly EditorVersion[]
  posterUrl: string | undefined
  onVersionChange: (id: string) => void
  onHistory: () => void
}

function VersionThumbnail({ posterUrl }: { posterUrl: string | undefined }) {
  return (
    <span aria-hidden="true" className="editor-version-thumbnail">
      {posterUrl ? (
        <img alt="" draggable={false} src={posterUrl} />
      ) : (
        <Icon decorative name="video" size="sm" />
      )}
    </span>
  )
}

export function EditorVersionMenu({
  version,
  versions,
  posterUrl,
  onVersionChange,
  onHistory,
}: EditorVersionMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const historyRequestedRef = useRef(false)

  return (
    <MenuRoot onOpenChange={setOpen} open={open}>
      <MenuTrigger asChild>
        <button
          aria-label="切换版本"
          className="editor-version-trigger ui-focus"
          ref={triggerRef}
          type="button"
        >
          <VersionThumbnail posterUrl={posterUrl} />
          <span>{version.label}</span>
          <Icon decorative name="expand" size="sm" />
        </button>
      </MenuTrigger>
      <MenuSurface
        align="start"
        aria-label="视频版本"
        aria-labelledby={undefined}
        className="editor-version-menu"
        collisionPadding={16}
        onCloseAutoFocus={(event) => {
          if (!historyRequestedRef.current) return
          event.preventDefault()
          historyRequestedRef.current = false
          // The dialog opens after the menu closes, with its return-focus target restored.
          triggerRef.current?.focus()
          onHistory()
        }}
        side="top"
        sideOffset={10}
      >
        <div className="editor-version-menu-header">
          <span>版本</span>
          <MenuItem
            className="editor-version-history"
            icon="history"
            onSelect={() => {
              historyRequestedRef.current = true
              setOpen(false)
            }}
          >
            历史
          </MenuItem>
        </div>
        <MenuRadioGroup
          className="editor-version-options"
          onValueChange={onVersionChange}
          value={version.id}
        >
          {[...versions].reverse().map((candidate) => {
            const parent = versions.find((item) => item.id === candidate.parentId)
            return (
              <MenuRadioItem
                aria-label={candidate.label}
                className="editor-version-option"
                key={candidate.id}
                textValue={candidate.label}
                value={candidate.id}
              >
                <VersionThumbnail posterUrl={posterUrl} />
                <span className="editor-version-copy">
                  <strong>{candidate.label}</strong>
                  <span>
                    {parent ? `基于${parent.label === '原片' ? '' : ' '}${parent.label} · ` : ''}
                    {Number(durationOf(candidate).toFixed(2))}s
                  </span>
                </span>
              </MenuRadioItem>
            )
          })}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}
