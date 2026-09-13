const trigger = document.getElementById('mascot-trigger');
const animation = new CueMascot(trigger.querySelector('svg'));
const status = document.getElementById('playback-status');
const slider = document.getElementById('progress');
const output = document.getElementById('progress-output');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let mode = 'interactive';
let pinned = false;
let pointerInside = false;

function setBackground(background) {
  if (!['light', 'dark', 'grid'].includes(background)) return;
  document.body.dataset.background = background;
  animation.setColor(background === 'dark' ? '#f4f1e9' : '#171818');
  for (const button of document.querySelectorAll('.background-controls button')) {
    button.setAttribute('aria-pressed', String(button.dataset.background === background));
  }
}

function updateState(expanded) {
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-label', expanded ? '收起鞋盒' : '展开鞋盒，展示鞋履与服装');
}

function setExpanded(expanded) {
  animation.setExpanded(expanded);
  updateState(expanded);
  slider.value = expanded ? '100' : '0';
  output.value = expanded ? '100%' : '0%';
  status.textContent = pinned ? '固定展开 · 再次点击收起' : expanded ? '展开' : '交互 · 悬停或点击鞋盒';
}

function setMode(nextMode) {
  animation.stop();
  mode = nextMode;
  pinned = false;
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  if (mode === 'loop') {
    if (reduceMotion.matches) {
      showProgress(100);
      status.textContent = '已遵循系统减少动态效果设置';
      return;
    }
    animation.play();
    output.value = '循环';
    updateState(true);
    status.textContent = '循环播放';
  } else if (mode === 'interactive') {
    setExpanded(pointerInside);
  } else {
    status.textContent = '逐帧预览';
  }
}

function showProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value)));
  if (!Number.isFinite(progress)) return;
  if (mode !== 'preview') setMode('preview');
  animation.setProgress(progress);
  slider.value = String(progress);
  output.value = `${Math.round(progress)}%`;
  updateState(progress > 0);
  status.textContent = progress === 0 ? '首帧' : progress === 100 ? '尾帧' : `展开进度 ${Math.round(progress)}%`;
}

trigger.addEventListener('pointerenter', (event) => {
  if (event.pointerType === 'touch') return;
  pointerInside = true;
  if (mode === 'interactive') setExpanded(true);
});
trigger.addEventListener('pointerleave', (event) => {
  if (event.pointerType === 'touch') return;
  pointerInside = false;
  if (mode === 'interactive' && !pinned) setExpanded(false);
});
trigger.addEventListener('click', () => {
  if (mode !== 'interactive') setMode('interactive');
  pinned = !pinned;
  setExpanded(pinned);
});
trigger.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    pinned = false;
    setMode('interactive');
    setExpanded(false);
  }
});
document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});
document.getElementById('show-idle').addEventListener('click', () => showProgress(0));
document.getElementById('show-expanded').addEventListener('click', () => showProgress(100));
slider.addEventListener('input', () => showProgress(slider.value));
document.querySelectorAll('.background-controls [data-background]').forEach((button) => {
  button.addEventListener('click', () => setBackground(button.dataset.background));
});
reduceMotion.addEventListener('change', () => {
  if (mode === 'loop' && reduceMotion.matches) showProgress(100);
});
window.addEventListener('pagehide', (event) => {
  if (event.persisted) animation.stop();
  else animation.destroy();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && mode === 'loop') animation.play();
});
setBackground('light');
setMode('interactive');
document.getElementById('load-status').hidden = true;
