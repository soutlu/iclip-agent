/** Animate the inline SVG exported by build_svg.py, without a rendering runtime. */
class CueMascot {
  constructor(svg) {
    if (!(svg instanceof SVGSVGElement)) {
      throw new TypeError('CueMascot requires an inline SVG element.');
    }
    this.svg = svg;
    this.nodes = [...svg.querySelectorAll('[data-cue-node]')].map((element) => {
      const from = element.dataset.from.split(',').map(Number);
      const to = element.dataset.to.split(',').map(Number);
      if (from.length !== 6 || to.length !== 6 || ![...from, ...to].every(Number.isFinite)) {
        throw new Error('The SVG contains an invalid animation pose.');
      }
      return { element, from, to };
    });
    if (this.nodes.length === 0) throw new Error('The SVG has no Cue animation poses.');
    this.progress = svg.dataset.expanded === 'true' ? 1 : 0;
    this.target = this.progress;
    this.frame = 0;
    this.timer = 0;
    this.looping = false;
    this.destroyed = false;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.motionChanged = () => {
      if (this.reduceMotion.matches) this.setProgress(this.target * 100);
    };
    this.reduceMotion.addEventListener('change', this.motionChanged);
    this.render(this.progress);
  }

  /** Immediately set the expanded pose to a percentage from 0 to 100. */
  setProgress(percent) {
    this.ensureActive();
    if (!Number.isFinite(percent)) throw new TypeError('Progress must be a finite number.');
    this.stop();
    this.target = Math.min(1, Math.max(0, percent / 100));
    this.render(this.target);
  }

  /** Open in 300 ms or close in 217 ms, continuing from the displayed pose. */
  setExpanded(expanded, { animate = true } = {}) {
    this.ensureActive();
    this.stop();
    const target = expanded ? 1 : 0;
    this.transition(target, animate ? (expanded ? 300 : 217) : 0);
  }

  /** Change only the Cue wordmark color. */
  setColor(color) {
    this.ensureActive();
    if (!CSS.supports('color', color)) throw new TypeError('Invalid CSS color.');
    this.svg.style.color = color;
  }

  /** Play the original 3.55 s showcase cycle, including its resting poses. */
  play() {
    this.ensureActive();
    this.stop();
    if (this.reduceMotion.matches) {
      this.target = 1;
      this.render(1);
      return;
    }
    this.looping = true;
    const cycle = () => {
      if (!this.looping) return;
      this.target = 0;
      this.render(0);
      this.timer = setTimeout(() => this.transition(1, 300, () => {
        this.timer = setTimeout(() => this.transition(0, 1000 * 13 / 60, () => {
          this.timer = setTimeout(cycle, 1000 * 8 / 60);
        }), 2000);
      }), 900);
    };
    cycle();
  }

  /** Stop at the current pose. */
  stop() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.frame = 0;
    this.timer = 0;
    this.looping = false;
  }

  /** Remove animation callbacks when the containing component is unmounted. */
  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.reduceMotion.removeEventListener('change', this.motionChanged);
    this.destroyed = true;
  }

  ensureActive() {
    if (this.destroyed) throw new Error('The CueMascot instance has been destroyed.');
  }

  render(progress) {
    this.progress = progress;
    this.svg.dataset.expanded = String(progress > 0);
    for (const { element, from, to } of this.nodes) {
      const p = from.map((start, i) => start + (to[i] - start) * progress);
      element.setAttribute('transform',
        `translate(${p[0]} ${p[1]}) rotate(${p[2] * 180 / Math.PI}) scale(${p[3]} ${p[4]})`);
      element.setAttribute('opacity', String(p[5]));
    }
  }

  transition(target, duration, complete) {
    cancelAnimationFrame(this.frame);
    this.target = target;
    if (this.reduceMotion.matches || !duration || this.progress === target) {
      this.render(target);
      complete?.();
      return;
    }
    const from = this.progress;
    const start = performance.now();
    const tick = (now) => {
      const time = Math.min(1, (now - start) / duration);
      this.render(from + (target - from) * CueMascot.ease(time));
      if (time < 1) this.frame = requestAnimationFrame(tick);
      else {
        this.render(target);
        this.frame = 0;
        complete?.();
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  static ease(x) {
    // Solve the shared Rive cubic-bezier(.3, .15, .7, .85) for this time.
    let low = 0;
    let high = 1;
    let t = x;
    for (let i = 0; i < 16; i++) {
      const at = 3 * (1 - t) ** 2 * t * 0.3 + 3 * (1 - t) * t ** 2 * 0.7 + t ** 3;
      if (at < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return 3 * (1 - t) ** 2 * t * 0.15 + 3 * (1 - t) * t ** 2 * 0.85 + t ** 3;
  }
}

window.CueMascot = CueMascot;
