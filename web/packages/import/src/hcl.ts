/**
 * Разбор HCL (Terraform) в объёме, которого хватает импорту: блоки с метками, атрибуты
 * и вложенные блоки. Выражения не вычисляются — атрибут хранится исходным текстом,
 * а из него потом достают литералы и ссылки на ресурсы. Строки с ${…}, heredoc и
 * комментарии #, // и /* *\/ пропускаются корректно.
 */

export class HclError extends Error {
  constructor(
    message: string,
    /** Номер строки с единицы. */
    readonly line: number,
  ) {
    super(`${message} (строка ${line})`);
    this.name = 'HclError';
  }
}

export interface HclBlock {
  type: string;
  labels: string[];
  /** Атрибуты тела: имя → исходный текст выражения. */
  attrs: Record<string, string>;
  blocks: HclBlock[];
  /** Всё тело блока исходным текстом: в нём ищутся ссылки на другие ресурсы. */
  text: string;
  line: number;
}

export interface HclBody {
  attrs: Record<string, string>;
  blocks: HclBlock[];
}

class Scanner {
  i = 0;

  constructor(private readonly s: string) {}

  get done(): boolean {
    return this.i >= this.s.length;
  }

  get c(): string {
    return this.s[this.i] ?? '';
  }

  line(at = this.i): number {
    let n = 1;
    for (let k = 0; k < at && k < this.s.length; k++) if (this.s[k] === '\n') n++;
    return n;
  }

  fail(message: string, at = this.i): never {
    throw new HclError(message, this.line(at));
  }

  slice(a: number, b: number): string {
    return this.s.slice(a, b);
  }

  /** Пропускает комментарий, если он начинается здесь. */
  comment(): boolean {
    const s = this.s;
    if (this.c === '#' || (this.c === '/' && s[this.i + 1] === '/')) {
      while (this.i < s.length && s[this.i] !== '\n') this.i++;
      return true;
    }
    if (this.c === '/' && s[this.i + 1] === '*') {
      const end = s.indexOf('*/', this.i + 2);
      if (end < 0) this.fail('Комментарий /* не закрыт');
      this.i = end + 2;
      return true;
    }
    return false;
  }

  /** Пробелы и комментарии; переводы строк — только если newlines. */
  space(newlines: boolean): void {
    for (;;) {
      if (this.c === ' ' || this.c === '\t' || this.c === '\r' || (newlines && this.c === '\n'))
        this.i++;
      else if (!this.comment()) return;
    }
  }

  ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  /** Строка в кавычках, начиная с ", вместе с интерполяциями ${…} и %{…}. */
  string(): string {
    const start = this.i;
    this.i++;
    let out = '';
    while (!this.done) {
      const c = this.c;
      if (c === '\\') {
        out += this.s.slice(this.i, this.i + 2);
        this.i += 2;
      } else if (c === '"') {
        this.i++;
        return out;
      } else if ((c === '$' || c === '%') && this.s[this.i + 1] === '{') {
        const from = this.i;
        this.i += 2;
        this.expr('}');
        this.i++;
        out += this.s.slice(from, this.i);
      } else if (c === '\n') {
        this.fail('Строка не закрыта', start);
      } else {
        out += c;
        this.i++;
      }
    }
    this.fail('Строка не закрыта', start);
  }

  /** <<EOF … EOF и <<-EOF с отступом. */
  heredoc(): void {
    const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(this.s.slice(this.i, this.i + 128));
    if (!m) {
      this.i += 2;
      return;
    }
    const start = this.i;
    this.i += m[0].length;
    const re = new RegExp(`^[ \\t]*${m[1]}[ \\t]*\\r?$`, 'm');
    const rest = this.s.slice(this.i);
    const end = re.exec(rest);
    if (!end) this.fail(`heredoc ${m[1]} не закрыт`, start);
    this.i += end.index + end[0].length;
  }

  /**
   * Выражение до конца строки (или до непарной закрывающей скобки close). Внутри скобок
   * переводы строк не заканчивают выражение. Возвращает конец последнего символа кода:
   * комментарий в конце строки (count = 3 # три) в выражение не входит.
   */
  expr(close: string | null): number {
    const stack: string[] = [];
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    let code = this.i;
    while (!this.done) {
      const c = this.c;
      if (this.comment()) continue;
      if (c === '"') this.string();
      else if (c === '<' && this.s[this.i + 1] === '<') this.heredoc();
      else if (c in pairs) {
        stack.push(pairs[c]!);
        this.i++;
      } else if (c === ')' || c === ']' || c === '}') {
        if (!stack.length) {
          if (close === c || (close === null && c === '}')) return code;
          this.fail(`Лишняя скобка ${c}`);
        }
        if (stack.pop() !== c) this.fail(`Скобка ${c} не на своём месте`);
        this.i++;
      } else if (c === '\n' && !stack.length && close === null) {
        return code;
      } else this.i++;
      if (!/\s/.test(c)) code = this.i;
    }
    if (stack.length || close) this.fail('Скобка не закрыта');
    return code;
  }
}

function body(sc: Scanner, top: boolean): HclBody {
  const attrs: Record<string, string> = {};
  const blocks: HclBlock[] = [];
  for (;;) {
    sc.space(true);
    if (sc.done) {
      if (!top) sc.fail('Блок не закрыт: нет }');
      return { attrs, blocks };
    }
    if (sc.c === '}') {
      if (top) sc.fail('Лишняя }');
      return { attrs, blocks };
    }
    const at = sc.i;
    const name = sc.c === '"' ? sc.string() : sc.ident();
    if (!name) sc.fail(`Неожиданный символ «${sc.c}»`);
    sc.space(false);
    if (sc.c === '=' && sc.slice(sc.i, sc.i + 2) !== '==') {
      sc.i++;
      sc.space(false);
      const from = sc.i;
      const end = sc.expr(null);
      attrs[name] = sc.slice(from, end).trim();
      continue;
    }
    const labels: string[] = [];
    while (sc.c !== '{') {
      if (sc.c === '"') labels.push(sc.string());
      else {
        const l = sc.ident();
        if (!l) sc.fail(`Ждали метку блока или {, а тут «${sc.c || 'конец файла'}»`);
        labels.push(l);
      }
      sc.space(false);
    }
    sc.i++;
    const from = sc.i;
    const inner = body(sc, false);
    const text = sc.slice(from, sc.i);
    sc.i++;
    blocks.push({ type: name, labels, ...inner, text, line: sc.line(at) });
  }
}

/** Разбирает файл .tf или .tfvars: атрибуты и блоки верхнего уровня. */
export function parseHcl(text: string): HclBody {
  return body(new Scanner(text.replace(/^﻿/, '')), true);
}
