/**
 * 首页 doodle：Kimi Code Web 空态 Rive 动画的静态 SVG 近似——浅灰大字打底，
 * 中间叠一台复古电脑，屏幕里是我们的 clip 图标（他们是 K3 终端字符）。
 *
 * 全部 fill / stroke 走 var(--color-*)：不走 currentColor 是因为一张图里要多色调；
 * token 换档后深浅两套主题自动跟随，无需 JS。hover 时电脑轻轻浮起。
 *
 * @returns 装饰性 doodle（aria-hidden，品牌名由 sr-only 标题承担）。
 */
export function HomeHeroDoodle() {
  return (
    <div className="group w-[min(420px,84vw)] animate-in duration-(--dur-l) fade-in">
      <svg
        aria-hidden
        className="block h-auto w-full select-none"
        viewBox="0 0 560 200"
        role="presentation"
      >
        {/* 浅灰大字：doodle 底色层 */}
        <text
          x="280"
          y="150"
          fill="var(--color-surface-container-high)"
          fontSize="92"
          fontWeight="650"
          letterSpacing="8"
          textAnchor="middle"
        >
          PRODUCER
        </text>

        {/* 复古电脑：hover 浮起 */}
        <g className="-translate-y-0 transition-transform duration-(--dur-s) group-hover:-translate-y-1">
          {/* 机身 */}
          <rect
            x="232"
            y="46"
            width="96"
            height="76"
            rx="12"
            fill="var(--color-surface-container-highest)"
            stroke="var(--color-outline-variant)"
            strokeWidth="1.5"
          />
          {/* 屏幕（主题中立的深色，取 artifact 轨底色） */}
          <rect x="244" y="56" width="72" height="50" rx="8" fill="var(--color-artifact-rail-bg)" />
          {/* 屏幕里的 clip 图标（lucide clapperboard 路径，24×24 源缩放） */}
          <g
            fill="none"
            stroke="var(--color-primary-container-solid)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            transform="translate(263.2 64.2) scale(1.4)"
          >
            <path d="m12.296 3.464 3.02 3.956" />
            <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.4z" />
            <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="m6.18 5.276 3.1 3.899" />
          </g>
          {/* 支架与底座 */}
          <rect
            x="272"
            y="122"
            width="16"
            height="14"
            fill="var(--color-surface-container-highest)"
          />
          <rect
            x="252"
            y="136"
            width="56"
            height="10"
            rx="5"
            fill="var(--color-surface-container-highest)"
          />
          {/* 键盘 */}
          <rect
            x="236"
            y="154"
            width="88"
            height="12"
            rx="6"
            fill="var(--color-surface-container-highest)"
            stroke="var(--color-outline-variant)"
            strokeWidth="1.5"
          />
        </g>
      </svg>
    </div>
  )
}
