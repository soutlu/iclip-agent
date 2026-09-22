import type { ReactNode } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

type GenerationDownloadProps = { url: string; watermarkUrl: string | null }

/** 只有原片时点了就下；上游也给了水印版时先选哪一份。 */
export function GenerationDownload({ url, watermarkUrl }: GenerationDownloadProps) {
  const { downloading, download } = useMediaDownload()
  const label = downloading ? '正在准备下载…' : '下载视频'

  const trigger = (
    <IconButton
      aria-busy={downloading}
      className={cn(
        'shrink-0 border-[0.5px] border-chat-hairline text-on-surface disabled:cursor-wait disabled:opacity-60',
        downloading && '[&_svg]:animate-spin',
      )}
      disabled={downloading}
      label={label}
      name={downloading ? 'loading' : 'download'}
      onClick={watermarkUrl === null ? () => void download(url, '生成的视频') : undefined}
      size="sm"
    />
  )
  if (watermarkUrl === null) return <DownloadTooltip label={label}>{trigger}</DownloadTooltip>
  return (
    <MenuRoot>
      <DownloadTooltip label={label}>
        <MenuTrigger asChild>{trigger}</MenuTrigger>
      </DownloadTooltip>
      <MenuSurface align="end">
        <MenuItem onSelect={() => void download(url, '生成的视频')}>下载原片</MenuItem>
        <MenuItem onSelect={() => void download(watermarkUrl, '生成的视频（水印版）')}>
          下载水印版
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

function DownloadTooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  )
}
