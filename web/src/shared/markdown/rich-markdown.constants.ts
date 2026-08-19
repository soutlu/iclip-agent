export const RICH_MARKDOWN_BASE_CSS = `
:host {
  color: var(--color-chat-message-text);
  color-scheme: light;
  display: block;
  font-family: var(--font-producer-ui, "Google Sans", "Google Sans Text", "Inter", system-ui, sans-serif);
  max-width: 100%;
  overflow-wrap: anywhere;
}

.rich-markdown-body,
.rich-markdown-body * {
  box-sizing: border-box;
}

.rich-markdown-body {
  color: var(--color-chat-message-text);
  font-family: var(--font-producer-ui, "Google Sans", "Google Sans Text", "Inter", system-ui, sans-serif);
  line-height: 1.68;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.rich-markdown-body > :first-child {
  margin-top: 0;
}

.rich-markdown-body > :last-child {
  margin-bottom: 0;
}

.rich-markdown-body h1,
.rich-markdown-body h2,
.rich-markdown-body h3,
.rich-markdown-body h4,
.rich-markdown-body h5,
.rich-markdown-body h6 {
  color: var(--color-chat-message-text);
  font-family: var(--font-producer-ui, "Google Sans", "Google Sans Text", "Inter", system-ui, sans-serif);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.18;
  margin: 1.28em 0 0.56em;
}

.rich-markdown-body p,
.rich-markdown-body div,
.rich-markdown-body span {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.rich-markdown-body p {
  margin: 0.92em 0;
}

.rich-markdown-body a {
  color: var(--color-chat-link-text);
  text-decoration: underline;
  text-decoration-color: var(--color-chat-link-border);
  text-underline-offset: 3px;
}

.rich-markdown-body ul,
.rich-markdown-body ol {
  margin: 0.95em 0;
  padding-left: 1.42em;
}

.rich-markdown-body li {
  margin: 0.58em 0;
  padding-left: 0.22em;
}

.rich-markdown-body li::marker {
  color: var(--color-chat-link-text);
}

.rich-markdown-body blockquote,
.rich-markdown-body .markdown-alert {
  border-left: 0.25em solid color-mix(in srgb, var(--color-primary) 38%, transparent);
  color: var(--color-chat-secondary-text);
  margin: 1.1em 0;
  padding: 0.18em 0 0.18em 1em;
}

.rich-markdown-body .markdown-alert-title {
  align-items: center;
  display: flex;
  font-weight: 650;
  gap: 0.45em;
  line-height: 1.2;
  margin-bottom: 0.48em;
}

.rich-markdown-body .markdown-alert-note {
  border-left-color: var(--color-primary);
}

.rich-markdown-body .markdown-alert-tip {
  border-left-color: var(--color-secondary);
}

.rich-markdown-body .markdown-alert-important {
  border-left-color: var(--color-primary);
}

.rich-markdown-body .markdown-alert-warning {
  border-left-color: var(--color-warning);
}

.rich-markdown-body .markdown-alert-caution {
  border-left-color: var(--color-error);
}

.rich-markdown-table-wrapper,
.rich-markdown-code-block {
  margin: 1.18em 0;
  max-width: 100%;
}

.rich-markdown-table-scroll,
.rich-markdown-code-scroll {
  max-width: 100%;
  overflow-x: auto;
}

.rich-markdown-table-toolbar,
.rich-markdown-code-toolbar {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 0.75em;
  min-height: 2.3em;
}

.rich-markdown-code-language {
  color: var(--color-chat-secondary-text);
  font-family: var(--font-producer-ui, "Google Sans", "Google Sans Text", "Inter", system-ui, sans-serif);
  font-size: 0.58em;
  font-weight: 650;
  text-transform: uppercase;
}

.rich-markdown-copy-button {
  align-items: center;
  background: color-mix(in srgb, var(--color-chat-card-bg) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-on-surface) 8%, transparent);
  border-radius: var(--radius-full);
  color: var(--color-chat-message-text);
  cursor: pointer;
  display: inline-flex;
  height: 2.1em;
  justify-content: center;
  padding: 0;
  transition: background-color var(--dur-s) var(--ease), color var(--dur-s) var(--ease), transform var(--dur-s) var(--ease);
  width: 2.1em;
}

.rich-markdown-copy-button:hover {
  background: var(--color-chat-card-bg);
  color: var(--color-chat-link-text);
}

.rich-markdown-copy-button:active {
  transform: scale(0.95);
}

/* v15 触控热区（M3 48px target）：视觉不变，可点范围外扩到 48×48 */
.rich-markdown-copy-button {
  position: relative;
}

.rich-markdown-copy-button::after {
  border-radius: inherit;
  content: '';
  height: 48px;
  left: 50%;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
}

.rich-markdown-body table {
  background: var(--color-chat-card-bg);
  border: 1px solid var(--color-chat-code-border);
  border-collapse: separate;
  border-radius: var(--radius-xl);
  border-spacing: 0;
  color: var(--color-chat-message-text);
  min-width: 100%;
  overflow: hidden;
  width: 100%;
}

.rich-markdown-body th,
.rich-markdown-body td {
  border-bottom: 1px solid var(--color-chat-code-border);
  border-right: 1px solid var(--color-chat-code-border);
  color: var(--color-chat-message-text);
  overflow-wrap: break-word;
  padding: 0.76em 0.92em;
  text-align: left;
  vertical-align: top;
}

.rich-markdown-body th {
  background: var(--color-chat-inline-bg);
  color: var(--color-chat-secondary-text);
  font-weight: 650;
}

.rich-markdown-body td {
  color: var(--color-chat-message-text);
}

.rich-markdown-body tr:last-child td {
  border-bottom: 0;
}

.rich-markdown-body th:last-child,
.rich-markdown-body td:last-child {
  border-right: 0;
}

.rich-markdown-body code {
  background: var(--color-chat-code-bg);
  border-radius: var(--radius-xs);
  color: var(--color-chat-message-text);
  font-family: "SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace;
  font-size: 0.92em;
  padding: 0.08em 0.32em;
}

.rich-markdown-code-block {
  border: 1px solid var(--color-chat-code-border);
  border-radius: var(--radius-xl);
  background: var(--color-chat-code-block-bg);
  overflow: hidden;
}

.rich-markdown-code-toolbar {
  background: var(--color-chat-inline-bg);
  border-bottom: 1px solid var(--color-chat-code-border);
  padding: 0.45em 0.7em;
}

.rich-markdown-code-block pre {
  margin: 0;
  overflow: visible;
  padding: 0.92em 1em;
}

.rich-markdown-code-block code {
  background: transparent;
  color: var(--color-chat-message-text);
  display: block;
  line-height: 1.62;
  padding: 0;
  white-space: pre;
}

.rich-markdown-body .katex-display {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 0.1em;
}

.rich-markdown-body .katex {
  color: inherit;
  max-width: 100%;
}

.rich-markdown-body details,
.rich-markdown-body summary,
.rich-markdown-body mark,
.rich-markdown-body sub,
.rich-markdown-body sup,
.rich-markdown-body hr {
  max-width: 100%;
}

.rich-markdown-body hr {
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--color-on-surface) 8%, transparent);
  margin: 1.35em 0;
}

.rich-markdown-svg,
.rich-markdown-body img {
  display: block;
  height: auto;
  margin: 1em 0;
  max-width: 100%;
}

.rich-markdown-table-label {
  color: var(--color-chat-secondary-text);
  font-family: var(--font-producer-ui, "Google Sans", "Google Sans Text", "Inter", system-ui, sans-serif);
  font-size: 0.58em;
  font-weight: 700;
  text-transform: uppercase;
}

.rich-markdown-canvas-body {
  font-size: var(--text-headline-lg);
}

.rich-markdown-canvas-body .rich-markdown-code-block pre code,
.rich-markdown-canvas-body .rich-markdown-pre-scroll code {
  font-size: var(--text-canvas-title-lg);
}

.rich-markdown-expanded-body {
  font-size: var(--text-canvas-label);
  font-weight: 400;
  line-height: 1.72;
  margin: 0;
  max-width: none;
  padding: 36px 44px 52px;
  width: 100%;
}

.rich-markdown-expanded-body .rich-markdown-code-block pre code,
.rich-markdown-expanded-body .rich-markdown-pre-scroll code {
  font-size: var(--text-body);
}

.rich-markdown-body.rich-markdown-focused-artifact-body > h1,
.rich-markdown-body.rich-markdown-focused-artifact-body > h2,
.rich-markdown-body.rich-markdown-focused-artifact-body > h3,
.rich-markdown-body.rich-markdown-focused-artifact-body > h4,
.rich-markdown-body.rich-markdown-focused-artifact-body > h5,
.rich-markdown-body.rich-markdown-focused-artifact-body > h6,
.rich-markdown-body.rich-markdown-focused-artifact-body > p,
.rich-markdown-body.rich-markdown-focused-artifact-body > ul,
.rich-markdown-body.rich-markdown-focused-artifact-body > ol,
.rich-markdown-body.rich-markdown-focused-artifact-body > blockquote {
  color: var(--color-on-background);
}

.rich-markdown-body.rich-markdown-focused-artifact-body > h1 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > h2 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > h3 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > h4 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > h5 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > h6 strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > p strong,
.rich-markdown-body.rich-markdown-focused-artifact-body > p em,
.rich-markdown-body.rich-markdown-focused-artifact-body li strong,
.rich-markdown-body.rich-markdown-focused-artifact-body li em {
  color: inherit;
}
`
