import type { SVGProps } from 'react'

export type StoryboardPreviewToolIconId = 'elements' | 'music'
export type StoryboardScreenToolIconType = 'download' | 'redo' | 'split'
export type StoryboardWorkbenchIconViewMode = 'script' | 'screen'

type StoryboardIconProps = Omit<
  SVGProps<SVGSVGElement>,
  'children' | 'height' | 'viewBox' | 'width'
> & {
  size?: number
}

export function StoryboardTitleIcon({ className = '', size = 24, ...props }: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 21 20"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M3.75 3.3h12.5a.45.45 0 0 1 .45.45V7.5a.45.45 0 0 1-.45.45H3.75a.45.45 0 0 1-.45-.45V3.75a.45.45 0 0 1 .45-.45Z"
          data-follow-stroke="currentColor"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          clipRule="evenodd"
          d="M15.093 11.25H3.75c-.69 0-1.25.56-1.25 1.25v3.75c0 .69.56 1.25 1.25 1.25h8.333a6.036 6.036 0 0 1-.053-1.6H4.1v-3.05h9.138a6.03 6.03 0 0 1 1.855-1.6Z"
          data-follow-fill="currentColor"
          fill="currentColor"
          fillRule="evenodd"
        />
        <path
          d="M16.612 12.654a.236.236 0 0 1 .443 0l.346.937a2.833 2.833 0 0 0 1.674 1.674l.938.347a.236.236 0 0 1 0 .443l-.938.346a2.833 2.833 0 0 0-1.674 1.674l-.346.938a.236.236 0 0 1-.443 0l-.347-.938a2.833 2.833 0 0 0-1.674-1.674l-.937-.346a.236.236 0 0 1 0-.443l.937-.347a2.833 2.833 0 0 0 1.674-1.674l.347-.937Z"
          data-follow-fill="currentColor"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

export function StoryboardToggleIcon({
  className = '',
  size = 24,
  viewMode,
  ...props
}: StoryboardIconProps & { viewMode: StoryboardWorkbenchIconViewMode }) {
  if (viewMode === 'screen') {
    return (
      <svg
        className={className}
        fill="none"
        height={size}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        viewBox="0 0 12 12"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <g>
          <path
            clipRule="evenodd"
            d="M10.013 6.506A1.1 1.1 0 0 1 11 7.6v2.3A1.1 1.1 0 0 1 9.9 11H7.6a1.1 1.1 0 0 1-1.094-.987L6.5 9.9V7.6a1.1 1.1 0 0 1 1.1-1.1h2.3l.113.006ZM7.6 7.5a.1.1 0 0 0-.1.1v2.3l.008.038A.1.1 0 0 0 7.6 10h2.3a.1.1 0 0 0 .1-.1V7.6a.1.1 0 0 0-.062-.092L9.9 7.5H7.6Z"
            data-follow-fill="currentColor"
            fill="currentColor"
            fillRule="evenodd"
          />
          <path
            d="M9.4 1.5a1.1 1.1 0 0 1 1.1 1.1v2.9h-1V2.6a.1.1 0 0 0-.1-.1H2.6a.1.1 0 0 0-.1.1v6.8a.1.1 0 0 0 .1.1h2.9v1H2.6a1.1 1.1 0 0 1-1.1-1.1V2.6a1.1 1.1 0 0 1 1.1-1.1h6.8Z"
            data-follow-fill="currentColor"
            fill="currentColor"
          />
          <path
            d="M6.05 3.286c.166 0 .302.135.302.3v.4a.3.3 0 0 1-.301.3H4.992l1.5 1.501a.3.3 0 0 1 0 .424l-.282.283a.3.3 0 0 1-.425 0l-1.5-1.5v1.059a.3.3 0 0 1-.3.3h-.4a.3.3 0 0 1-.3-.3V3.786a.5.5 0 0 1 .5-.5h2.266Z"
            data-follow-fill="currentColor"
            fill="currentColor"
          />
        </g>
      </svg>
    )
  }

  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 12 12"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M1.5 2.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v3h-1v-3h-7v7h3v1h-3a1 1 0 0 1-1-1v-7Z"
          data-follow-fill="var(--storyboard-node-ink)"
          fill="var(--storyboard-node-ink)"
        />
        <path
          clipRule="evenodd"
          d="M6.5 7.5a1 1 0 0 1 1-1H10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V7.5Zm3.5 0H7.5V10H10V7.5Z"
          data-follow-fill="var(--storyboard-node-ink)"
          fill="var(--storyboard-node-ink)"
          fillRule="evenodd"
        />
        <path
          d="M5.999 6.499a.5.5 0 0 0 .5-.5V3.683a.25.25 0 0 0-.25-.25h-.5a.25.25 0 0 0-.25.25v1.109L3.963 3.256a.25.25 0 0 0-.353 0l-.354.354a.25.25 0 0 0 0 .353L4.791 5.5H3.683a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h2.316Z"
          data-follow-fill="var(--storyboard-node-ink)"
          fill="var(--storyboard-node-ink)"
        />
      </g>
    </svg>
  )
}

export function StoryboardDividerIcon({
  className = '',
  size = 40,
  ...props
}: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 20 20"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M3.844 4.747c2.908-2.451 6.656-2.247 9.825.386l5.624 4.416a.8.8 0 0 1 .02 1.243l-5.651 4.734s-.27.258-.413.38a7.424 7.424 0 0 1-.481.37l-.291.196A7.296 7.296 0 0 1 3.253 5.305l-.03-.036.064-.002c.175-.18.36-.354.557-.52Z"
          fill="var(--storyboard-node-accent)"
        />
        <path
          d="M9 6.25a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3a.5.5 0 0 1 .5-.5Z"
          fill="var(--color-surface-container-lowest)"
        />
      </g>
    </svg>
  )
}

export function StoryboardDragDotsIcon({
  className = '',
  size = 24,
  ...props
}: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 12 12"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          clipRule="evenodd"
          d="M4.08 3.265c.596 0 1.08-.479 1.08-1.07 0-.59-.484-1.07-1.08-1.07-.596 0-1.08.48-1.08 1.07 0 .591.484 1.07 1.08 1.07Zm3.84 0c.596 0 1.08-.479 1.08-1.07 0-.59-.484-1.07-1.08-1.07-.596 0-1.08.48-1.08 1.07 0 .591.484 1.07 1.08 1.07ZM9 6c0 .591-.484 1.07-1.08 1.07-.596 0-1.08-.479-1.08-1.07 0-.591.484-1.07 1.08-1.07C8.516 4.93 9 5.409 9 6ZM4.08 7.07c.596 0 1.08-.479 1.08-1.07 0-.591-.484-1.07-1.08-1.07C3.484 4.93 3 5.409 3 6c0 .591.484 1.07 1.08 1.07ZM9 9.805c0 .59-.484 1.07-1.08 1.07-.596 0-1.08-.48-1.08-1.07 0-.591.484-1.07 1.08-1.07.596 0 1.08.479 1.08 1.07Zm-4.92 1.07c.596 0 1.08-.48 1.08-1.07 0-.591-.484-1.07-1.08-1.07-.596 0-1.08.479-1.08 1.07 0 .59.484 1.07 1.08 1.07Z"
          data-follow-fill="currentColor"
          fill="var(--color-inverse-surface)"
          fillOpacity=".4"
          fillRule="evenodd"
        />
      </g>
    </svg>
  )
}

export function StoryboardMoreIcon({ className = '', size = 32, ...props }: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 14 14"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M4.333 6.998a1.067 1.067 0 1 1-2.133 0 1.067 1.067 0 0 1 2.133 0Zm3.734 0a1.067 1.067 0 1 1-2.134 0 1.067 1.067 0 0 1 2.134 0Zm2.666 1.067a1.067 1.067 0 1 0 0-2.133 1.067 1.067 0 0 0 0 2.133Z"
          data-follow-fill="var(--storyboard-node-ink)"
          fill="var(--storyboard-node-muted)"
        />
      </g>
    </svg>
  )
}

export function StoryboardNarratorIcon({
  className = '',
  size = 24,
  ...props
}: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          clipRule="evenodd"
          d="M7.2 8.8v4.867c0 .184.15.333.333.333h.934c.184 0 .333-.15.333-.333V8.8h4.867c.184 0 .333-.15.333-.333v-.934a.333.333 0 0 0-.333-.333H8.8V2.333A.333.333 0 0 0 8.467 2h-.934a.333.333 0 0 0-.333.333V7.2H2.333A.333.333 0 0 0 2 7.533v.934c0 .184.15.333.333.333H7.2Z"
          data-follow-fill="currentColor"
          fill="currentColor"
          fillRule="evenodd"
        />
      </g>
    </svg>
  )
}

export function StoryboardAddScreenIcon({
  className = '',
  size = 32,
  ...props
}: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <g data-follow-fill="currentColor" fill="var(--color-inverse-surface)" fillOpacity=".4">
          <path d="M3 3.666h10v6h1.333v-6c0-.736-.597-1.333-1.333-1.333H3c-.737 0-1.333.597-1.333 1.333v8.667c0 .736.596 1.333 1.333 1.333h7.333v-1.333H3V3.666Z" />
          <path d="M14.333 12.333V11H13v1.333h-1.334v1.333H13V15h1.333v-1.334h1.333v-1.333h-1.333ZM7.234 6.27 9.51 7.718a.333.333 0 0 1 0 .563L7.234 9.729a.333.333 0 0 1-.512-.281V6.552c0-.263.29-.423.512-.282Z" />
        </g>
      </g>
    </svg>
  )
}

export function StoryboardScreenToolIcon({
  className = '',
  size = 32,
  type,
  ...props
}: StoryboardIconProps & { type: StoryboardScreenToolIconType }) {
  if (type === 'redo') {
    return (
      <svg
        className={className}
        fill="none"
        height={size}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        viewBox="0 0 16 16"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <g>
          <path
            clipRule="evenodd"
            d="M3.335 4.335h8.723l-1.01 1.011a.295.295 0 0 0 0 .417l.525.526a.295.295 0 0 0 .417 0l1.622-1.622h.008v-.008l.519-.519a.667.667 0 0 0 0-.943L11.99 1.05a.295.295 0 0 0-.417 0l-.526.526a.295.295 0 0 0 0 .417l1.011 1.01H3.335A1.333 1.333 0 0 0 2 4.335V7.04c0 .163.132.295.295.295h.744a.295.295 0 0 0 .295-.295V4.335Zm.613 8.667 1.01 1.01a.295.295 0 0 1 0 .418l-.525.526a.295.295 0 0 1-.417 0l-2.149-2.15a.667.667 0 0 1 0-.942l.519-.519v-.011h.012l1.618-1.619a.295.295 0 0 1 .417 0l.526.526a.295.295 0 0 1 0 .417l-1.011 1.01h8.72V8.963c0-.163.132-.295.295-.295h.744c.162 0 .294.132.294.295v2.707c0 .736-.596 1.333-1.333 1.333h-8.72Z"
            data-follow-fill="currentColor"
            fill="currentColor"
            fillRule="evenodd"
          />
        </g>
      </svg>
    )
  }

  if (type === 'split') {
    return (
      <svg
        className={className}
        fill="none"
        height={size}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        viewBox="0 0 16 16"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <g>
          <path
            clipRule="evenodd"
            d="M6.684 5.744a2.667 2.667 0 1 0-1.192.793l2.16 1.512-2.068 1.447a2.667 2.667 0 1 0 1.151.822l2.078-1.456 5.667 3.969a.118.118 0 0 0 .186-.097v-1.248a.294.294 0 0 0-.126-.241L9.976 8.049l4.564-3.196a.295.295 0 0 0 .126-.242V3.363a.118.118 0 0 0-.186-.096L8.813 7.235 6.684 5.744Zm-2.017-.41a1.333 1.333 0 1 0 0-2.667 1.333 1.333 0 0 0 0 2.667Zm0 8a1.333 1.333 0 1 0 0-2.667 1.333 1.333 0 0 0 0 2.667Z"
            data-follow-fill="currentColor"
            fill="currentColor"
            fillRule="evenodd"
          />
        </g>
      </svg>
    )
  }

  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <g data-follow-fill="currentColor" fill="currentColor" fillRule="evenodd">
          <path
            clipRule="evenodd"
            d="M8.667 2.333A.333.333 0 0 0 8.333 2h-.666a.333.333 0 0 0-.334.333v6.53L4.996 6.526a.333.333 0 0 0-.471 0l-.472.471a.333.333 0 0 0 0 .472l3.476 3.476a.667.667 0 0 0 .942 0l3.476-3.476a.333.333 0 0 0 0-.472l-.472-.471a.333.333 0 0 0-.471 0L8.667 8.862V2.333ZM2.667 11a.667.667 0 0 1 .666.667V13h9.334v-1.333a.667.667 0 0 1 1.333 0v1.666c0 .552-.448 1-1 1H3a1 1 0 0 1-1-1v-1.666A.667.667 0 0 1 2.667 11Z"
          />
        </g>
      </g>
    </svg>
  )
}

export function StoryboardPreviewToolIcon({
  className = '',
  id,
  size = 32,
  ...props
}: StoryboardIconProps & { id: StoryboardPreviewToolIconId }) {
  if (id === 'music') {
    return (
      <svg
        className={className}
        fill="none"
        height={size}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        viewBox="0 0 20 20"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <g>
          <path
            data-follow-fill="currentColor"
            d="M0 0h20v20H0z"
            fill="var(--storyboard-node-muted-strong)"
            fillOpacity=".01"
          />
          <path
            d="M16.666 10a6.636 6.636 0 0 0-.87-3.296l1.213-1.213a8.333 8.333 0 1 1-7.841-3.783c.458-.045.832.332.832.792s-.375.828-.832.885A6.668 6.668 0 1 0 16.666 10Z"
            data-follow-fill="currentColor"
            fill="var(--storyboard-node-muted-strong)"
          />
          <path
            clipRule="evenodd"
            d="M13.267 2.034a1 1 0 0 0-1.6.8v4.279a3.333 3.333 0 1 0 1.665 2.79h.001V4.167l1.347 1.01 1.19-1.19-2.603-1.953ZM8.332 10a1.667 1.667 0 1 1 3.333 0 1.667 1.667 0 0 1-3.333 0Z"
            data-follow-fill="currentColor"
            fill="var(--storyboard-node-muted-strong)"
            fillRule="evenodd"
          />
        </g>
      </svg>
    )
  }

  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 20 20"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M12.721 1.821a.236.236 0 0 0-.442 0l-.347.937a2.833 2.833 0 0 1-1.674 1.674l-.937.347a.236.236 0 0 0 0 .443l.937.347a2.833 2.833 0 0 1 1.674 1.673l.347.938a.236.236 0 0 0 .442 0l.347-.938a2.833 2.833 0 0 1 1.674-1.673l.937-.347a.236.236 0 0 0 0-.443l-.937-.347a2.833 2.833 0 0 1-1.674-1.674l-.347-.937ZM6.833 5.116a.177.177 0 0 0-.332 0l-.26.703a2.125 2.125 0 0 1-1.256 1.255l-.703.26a.177.177 0 0 0 0 .332l.703.26c.582.216 1.04.674 1.256 1.256l.26.703a.177.177 0 0 0 .332 0l.26-.703a2.125 2.125 0 0 1 1.255-1.256l.703-.26a.177.177 0 0 0 0-.332l-.703-.26A2.125 2.125 0 0 1 7.093 5.82l-.26-.703Zm3.89 4.961a.118.118 0 0 1 .221 0l.173.469c.144.388.45.693.837.837l.469.173a.118.118 0 0 1 0 .222l-.469.173c-.387.144-.693.45-.837.837l-.173.469a.118.118 0 0 1-.221 0l-.174-.469a1.417 1.417 0 0 0-.837-.837l-.468-.173a.118.118 0 0 1 0-.222l.468-.173c.388-.144.694-.45.837-.837l.174-.469Z"
          data-follow-fill="currentColor"
          fill="var(--storyboard-node-muted-strong)"
        />
        <path
          d="m2.428 15.29 1.132-3.286a.5.5 0 0 1 .472-.337h.706a.5.5 0 0 1 .472.663l-1.207 3.504h11.993L14.79 12.33a.5.5 0 0 1 .472-.663h.705a.5.5 0 0 1 .473.337l1.132 3.287a1.667 1.667 0 0 1-1.576 2.21H4.003a1.667 1.667 0 0 1-1.575-2.21Z"
          data-follow-fill="currentColor"
          fill="var(--storyboard-node-muted-strong)"
        />
      </g>
    </svg>
  )
}

export function StoryboardPlayIcon({ className = '', size = 32, ...props }: StoryboardIconProps) {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      viewBox="0 0 6 6"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <path
          d="M5.11 2.782a.25.25 0 0 1 0 .436l-3.488 1.95a.25.25 0 0 1-.372-.219V1.051a.25.25 0 0 1 .372-.218l3.487 1.949Z"
          data-follow-fill="currentColor"
          fill="var(--storyboard-node-surface)"
        />
      </g>
    </svg>
  )
}
