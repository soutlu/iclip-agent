import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import HippoIcon, { type HippoIconName } from '@/shared/ui/icons/HippoIcon'
import PopupContent from '@/shared/ui/popup/PopupContent'
import { usePopupAnchor } from '@/shared/ui/popup/usePopupAnchor'

/* ================================================================
   汉堡菜单项
   ================================================================ */
interface HamburgerMenuActionItem {
  href?: string
  icon: HippoIconName
  label: string
  shortcut?: string
}

interface HamburgerMenuDividerItem {
  type: 'divider'
}

type HamburgerMenuItem = HamburgerMenuActionItem | HamburgerMenuDividerItem

const isHamburgerMenuDividerItem = (item: HamburgerMenuItem): item is HamburgerMenuDividerItem =>
  'type' in item
const MENU_PLACEHOLDER_TITLE = '暂未开放'

const hamburgerMenuItems: HamburgerMenuItem[] = [
  { href: '/', icon: 'back', label: '前往所有项目页面' },
  { icon: 'share', label: '共享' },
  { icon: 'download', label: '下载项目' },
  { icon: 'copy', label: '复制项目' },
  { type: 'divider' },
  { icon: 'edit', label: '修改' },
  { icon: 'help', label: '帮助' },
  { type: 'divider' },
  { icon: 'switch', label: 'Dark mode' },
  { icon: 'setting', label: '设置' },
  { type: 'divider' },
  { icon: 'ashbin', label: '删除项目' },
  { icon: 'keyboard-26', label: '命令菜单', shortcut: '⌘K' },
  { icon: 'comment', label: '发送反馈' },
]

/* ================================================================
   左侧 Header 组件：汉堡菜单
   ================================================================ */
export default function ProjectHeaderLeft() {
  const {
    anchorRect,
    open: menuOpen,
    setOpen: setMenuOpen,
    triggerRef,
    updateAnchorRect,
  } = usePopupAnchor<HTMLButtonElement>()

  const closeMenu = useCallback(() => setMenuOpen(false), [setMenuOpen])

  const handleMenuAction = useCallback(() => setMenuOpen(false), [setMenuOpen])

  return (
    <div className="flex max-w-[var(--layout-project-header-max-left)] shrink-0 items-center gap-1 overflow-hidden md:gap-2">
      {/* 汉堡菜单按钮 — 椭圆 48×32 */}
      <div className="relative flex shrink-0 rounded-full">
        <button
          ref={triggerRef}
          type="button"
          className="flex h-8 w-12 items-center justify-center rounded-full border border-border bg-header-btn-bg text-on-background backdrop-blur-md transition-all duration-[var(--dur-s)] select-none hover:bg-hover active:scale-95"
          onClick={() => {
            updateAnchorRect()
            setMenuOpen((current) => !current)
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="打开菜单"
        >
          <HippoIcon name="menu" size={20} />
        </button>
      </div>

      <PopupContent
        open={menuOpen}
        anchorRect={anchorRect}
        align="bottom-start"
        onDismiss={closeMenu}
        role="menu"
        aria-label="项目菜单"
        className="min-w-[220px] py-1.5"
      >
        <HamburgerMenu items={hamburgerMenuItems} onAction={handleMenuAction} />
      </PopupContent>
    </div>
  )
}

/* ================================================================
   汉堡菜单组件（支持分割线和快捷键）
   ================================================================ */
function HamburgerMenu({ items, onAction }: { items: HamburgerMenuItem[]; onAction: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (isHamburgerMenuDividerItem(item)) {
          return <div key={`divider-${i.toString()}`} className="mx-3 my-1.5 h-px bg-border" />
        }

        const content = (
          <>
            <span className="flex items-center gap-3">
              <span className="flex w-5 items-center justify-center">
                <HippoIcon name={item.icon} size={15} />
              </span>
              {item.label}
            </span>
            {item.shortcut ? (
              <span className="text-caption text-on-surface-variant">{item.shortcut}</span>
            ) : null}
          </>
        )

        if (item.href) {
          return (
            <Link
              to={item.href}
              key={item.label}
              role="menuitem"
              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-body-sm text-on-background transition-colors ui-motion-s hover:bg-hover"
              onClick={onAction}
            >
              {content}
            </Link>
          )
        }

        return (
          <button
            type="button"
            aria-disabled="true"
            key={item.label}
            role="menuitem"
            className="flex w-full cursor-not-allowed items-center justify-between gap-3 px-4 py-2.5 text-left text-body-sm text-on-surface-variant opacity-72"
            disabled
            title={`${item.label}（${MENU_PLACEHOLDER_TITLE}）`}
          >
            {content}
          </button>
        )
      })}
    </>
  )
}
