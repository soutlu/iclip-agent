import { cn } from '@/shared/lib/utils'

interface ProjectComposerToolbarProps {
  compact?: boolean
  disabled: boolean
  onSubmit: () => void
}

export default function ProjectComposerToolbar({
  compact = false,
  disabled,
  onSubmit,
}: ProjectComposerToolbarProps) {
  const submitLabel = '发送'

  return (
    <div className={cn('flex shrink-0 items-center justify-end', compact ? 'pt-2' : 'pt-5')}>
      <button
        type="button"
        disabled={disabled}
        className={cn(
          'hit-48 relative flex h-8 w-8 items-center justify-center rounded-full transition-all duration-[var(--dur-s)] ease-[var(--ease)]',
          !disabled
            ? 'cursor-pointer bg-[var(--color-on-background)] text-[var(--color-background)] hover:scale-105 active:scale-95'
            : 'cursor-not-allowed border-none bg-transparent text-[var(--color-disabled-text)]',
        )}
        aria-label={submitLabel}
        onClick={onSubmit}
      >
        <svg aria-hidden="true" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
          <title>{submitLabel}</title>
          <path d="M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z" />
        </svg>
      </button>
    </div>
  )
}
