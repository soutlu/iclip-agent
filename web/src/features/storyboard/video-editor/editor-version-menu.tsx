/** 时间线上的版本切换菜单：各版与已能预览的编辑，带缩略图、基于哪一版、时长。 */

import { Icon } from '@/shared/icons'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { roundSeconds } from './time-label'
import './editor-version-menu.css'

export type VersionMenuEntry = {
  key: string
  label: string
  /** 基于哪一版；根没有。 */
  baseLabel: string | undefined
  /** 还没合成的编辑预览带阶段说明。 */
  note: string | undefined
  mediaUrl: string
  duration: number | undefined
}

type EditorVersionMenuProps = {
  entries: readonly VersionMenuEntry[]
  selectedKey: string
  label: string
  posterOf: (url: string) => string | undefined
  onSelect: (key: string) => void
}

function VersionThumbnail({ poster }: { poster: string | undefined }) {
  return (
    <span aria-hidden="true" className="video-editor-version-thumbnail">
      {poster === undefined ? (
        <Icon decorative name="video" size="sm" />
      ) : (
        <img alt="" draggable={false} src={poster} />
      )}
    </span>
  )
}

export function EditorVersionMenu({
  entries,
  selectedKey,
  label,
  posterOf,
  onSelect,
}: EditorVersionMenuProps) {
  const selected = entries.find((entry) => entry.key === selectedKey)

  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          aria-label="切换版本"
          className="video-editor-version-trigger ui-focus"
          type="button"
        >
          <VersionThumbnail
            poster={selected === undefined ? undefined : posterOf(selected.mediaUrl)}
          />
          <span>{label}</span>
          <Icon decorative name="expand" size="sm" />
        </button>
      </MenuTrigger>
      <MenuSurface
        align="start"
        aria-label="视频版本"
        aria-labelledby={undefined}
        className="video-editor-version-menu"
        collisionPadding={16}
        side="top"
        sideOffset={10}
      >
        <div className="video-editor-version-menu-header">
          <span>版本</span>
        </div>
        <MenuRadioGroup
          className="video-editor-version-options"
          onValueChange={onSelect}
          value={selectedKey}
        >
          {[...entries].reverse().map((entry) => (
            <MenuRadioItem
              aria-label={entry.label}
              className="video-editor-version-option"
              key={entry.key}
              textValue={entry.label}
              value={entry.key}
            >
              <VersionThumbnail poster={posterOf(entry.mediaUrl)} />
              <span className="video-editor-version-copy">
                <strong>{entry.label}</strong>
                <span>
                  {[
                    entry.baseLabel === undefined ? undefined : `基于 ${entry.baseLabel}`,
                    entry.note,
                    entry.duration === undefined ? undefined : `${roundSeconds(entry.duration)}s`,
                  ]
                    .filter((part) => part !== undefined)
                    .join(' · ')}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSurface>
    </MenuRoot>
  )
}
