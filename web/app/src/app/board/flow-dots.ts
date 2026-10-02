import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
} from '@angular/core';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Скорость точек вдоль связи, px/с. */
const SPEED = 90;

/**
 * Бегущие точки-запросы на связи Foblex. Рядом с линией связи кладётся вторая линия
 * с тем же путём и пунктиром из точек, а CSS сдвигает пунктир. Кадры считает браузер,
 * JS на каждый кадр не работает. Чем больше поток, тем гуще точки.
 */
@Directive({ selector: 'f-connection[llFlowDots]' })
export class FlowDots {
  /** Поток по связи, rps. 0 — точек нет. */
  readonly llFlowDots = input(0);

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private dots: SVGPathElement | null = null;
  private observer: MutationObserver | null = null;

  constructor() {
    afterNextRender(() => this.attach());

    effect(() => {
      const rps = this.llFlowDots();
      this.paint(rps);
    });

    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.dots?.remove();
    });
  }

  private attach(attempt = 0): void {
    const path = this.host.querySelector<SVGPathElement>('path.f-connection-path');
    if (!path) {
      // Foblex рисует путь асинхронно после первого расчёта геометрии.
      if (attempt < 20) setTimeout(() => this.attach(attempt + 1), 50);
      return;
    }
    const dots = document.createElementNS(SVG_NS, 'path');
    dots.setAttribute('class', 'll-flow');
    dots.setAttribute('aria-hidden', 'true');
    path.after(dots);
    this.dots = dots;

    const sync = (): void => {
      const d = path.getAttribute('d');
      if (d) dots.setAttribute('d', d);
    };
    sync();
    this.observer = new MutationObserver(sync);
    this.observer.observe(path, { attributes: true, attributeFilter: ['d'] });
    this.paint(this.llFlowDots());
  }

  private paint(rps: number): void {
    const dots = this.dots;
    if (!dots) return;
    if (rps <= 0) {
      dots.style.display = 'none';
      return;
    }
    // 1 точка на 200 px при единицах rps, до 9 при десятках тысяч.
    const perSegment = Math.min(9, Math.max(1, Math.round(Math.log10(rps + 1) * 2.2)));
    const gap = 200 / perSegment;
    dots.style.display = '';
    dots.style.setProperty('--ll-gap', `${gap}px`);
    dots.style.strokeDasharray = `0 ${gap}`;
    dots.style.animationDuration = `${gap / SPEED}s`;
  }
}
