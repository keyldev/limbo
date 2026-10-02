import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type { NodeKind } from '@loadline/model';

/** Контуры иконок 24×24, рисуются цветом текста. Это константы, а не пользовательский ввод. */
const SHAPES: Record<NodeKind, string> = {
  client:
    '<rect x="2" y="4" width="13" height="10" rx="1.5"/><path d="M6 18h5M8.5 14v4"/><rect x="17" y="8" width="5" height="11" rx="1"/>',
  cdn: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/>',
  'load-balancer':
    '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v10M11 9l-5 8M13 9l5 8"/>',
  'api-gateway':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 8l-2 8"/>',
  service: '<path d="M12 2l8.5 5v10L12 22l-8.5-5V7z"/><circle cx="12" cy="12" r="3"/>',
  worker:
    '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  cache: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M13 6l-5 7h4l-1 5 5-7h-4z"/>',
  'sql-primary':
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  'sql-replica':
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" stroke-dasharray="2.5 2.5"/><path d="M9 13l2 2 4-4"/>',
  nosql:
    '<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  queue: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M7 7v10M12 7v10M17 7v10"/>',
  'object-storage': '<path d="M4 6l2 14h12l2-14"/><ellipse cx="12" cy="6" rx="8" ry="2.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
};

@Component({
  selector: 'll-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      [innerHTML]="shape()"
    ></svg>
  `,
  styles: `
    :host {
      display: inline-grid;
      place-items: center;
    }
  `,
})
export class Icon {
  readonly kind = input.required<NodeKind>();
  readonly size = input(18);

  private readonly sanitizer = inject(DomSanitizer);
  // Санитайзер Angular вырезает SVG из innerHTML. Формы — константы выше, поэтому доверяем им явно.
  protected readonly shape = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(SHAPES[this.kind()]),
  );
}
