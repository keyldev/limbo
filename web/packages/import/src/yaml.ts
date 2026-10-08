/**
 * Разбор YAML в объём, которого хватает docker-compose: блочные словари и списки,
 * flow-коллекции [a, b] и {a: 1}, строки в кавычках, блочные строки | и >, якоря,
 * ссылки и слияние <<. Теги (!reset, !!str) пропускаются. Скаляры — по схеме core YAML 1.2.
 * Сложных ключей (?), нескольких документов в одном файле и директив нет.
 */

export class YamlError extends Error {
  constructor(
    message: string,
    /** Номер строки с единицы. */
    readonly line: number,
  ) {
    super(`${message} (строка ${line})`);
    this.name = 'YamlError';
  }
}

interface Line {
  no: number;
  indent: number;
  /** Содержимое без отступа и комментария. */
  text: string;
  /** Строка целиком — для блочных строк, где # не комментарий. */
  raw: string;
}

const MERGE = '<<';

/** Обрезает комментарий: # в начале или после пробела, не внутри кавычек. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      // Кавычка открывает строку только в начале скаляра, иначе это апостроф в тексте.
      const prev = s.slice(0, i).trimEnd();
      if (prev === '' || /[:\-[{,]$/.test(prev) || /^[&!*]\S*$/.test(prev.split(/\s/).pop()!))
        quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

/** Индекс «: » (или «:» в конце), отделяющего ключ, вне кавычек и скобок. -1 — это не пара. */
function keySplit(s: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && i === 0) quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i + 1 === s.length || /\s/.test(s[i + 1]!))) return i;
  }
  return -1;
}

const isSeqItem = (text: string): boolean => text === '-' || text.startsWith('- ');

/** Скаляр без кавычек → null, boolean, число или строка (core schema YAML 1.2). */
function plain(s: string): unknown {
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
  e: '\x1b',
};

/** Строка в кавычках, начиная с s[at]. Возвращает значение и позицию после закрывающей кавычки. */
function quoted(s: string, at: number, no: number): { value: string; end: number } {
  const q = s[at]!;
  let out = '';
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
        } else return { value: out, end: i + 1 };
      } else out += c;
    } else if (c === '\\') {
      const n = s[++i];
      if (n === 'x' || n === 'u' || n === 'U') {
        const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        out += String.fromCodePoint(parseInt(s.slice(i + 1, i + 1 + len), 16));
        i += len;
      } else if (n !== undefined && n in ESCAPES) out += ESCAPES[n];
      else throw new YamlError(`Неизвестная escape-последовательность \\${n ?? ''}`, no);
    } else if (c === '"') return { value: out, end: i + 1 };
    else out += c;
  }
  throw new YamlError('Строка в кавычках не закрыта', no);
}

/** Сливает словари из << в словарь: явные ключи сильнее, из ранних источников — сильнее поздних. */
function applyMerge(target: Record<string, unknown>, sources: unknown, no: number): void {
  const list = Array.isArray(sources) ? sources : [sources];
  for (const src of list) {
    if (typeof src !== 'object' || src === null || Array.isArray(src))
      throw new YamlError('<< ждёт ссылку на словарь', no);
    for (const [k, v] of Object.entries(src)) if (!(k in target)) target[k] = v;
  }
}

class Parser {
  private i = 0;
  private readonly anchors = new Map<string, unknown>();

  constructor(
    private readonly lines: Line[],
    /** Исходные строки: в блочной строке строка из одного комментария — это текст. */
    private readonly src: readonly string[],
  ) {}

  parse(): unknown {
    if (!this.lines.length) return null;
    const first = this.lines[0]!;
    const value = this.block(first.indent);
    const rest = this.lines[this.i];
    if (rest) throw new YamlError('Лишний отступ или неожиданное продолжение', rest.no);
    return value;
  }

  private get line(): Line | undefined {
    return this.lines[this.i];
  }

  /** Узел, который начинается на текущей строке с отступом indent. */
  private block(indent: number): unknown {
    const l = this.line!;
    if (isSeqItem(l.text)) return this.seq(indent);
    if (keySplit(l.text) >= 0) return this.map(indent);
    this.i++;
    return this.inline(l.text, l, indent);
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const merges: [unknown, number][] = [];
    for (let l = this.line; l && l.indent === indent && !isSeqItem(l.text); l = this.line) {
      const at = keySplit(l.text);
      if (at < 0) throw new YamlError('Ожидалась пара «ключ: значение»', l.no);
      const keyText = l.text.slice(0, at).trim();
      const key =
        keyText.startsWith('"') || keyText.startsWith("'")
          ? quoted(keyText, 0, l.no).value
          : keyText.replace(/^!\S*\s*/, '');
      if (key.startsWith('?')) throw new YamlError('Сложные ключи (?) не поддерживаются', l.no);
      this.i++;
      const value = this.inline(l.text.slice(at + 1).trim(), l, indent, true);
      if (key === MERGE) merges.push([value, l.no]);
      else out[key] = value;
    }
    for (const [src, no] of merges) applyMerge(out, src, no);
    return out;
  }

  private seq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (let l = this.line; l && l.indent === indent && isSeqItem(l.text); l = this.line) {
      const rest = l.text.slice(1).trimStart();
      if (rest && (isSeqItem(rest) || keySplit(rest) >= 0) && !/^[[{"'&*!|>]/.test(rest)) {
        // «- key: value» и «- - a»: содержимое пункта — блок с отступом его первого символа.
        const offset = l.text.length - rest.length;
        this.lines[this.i] = { ...l, indent: indent + offset, text: rest };
        out.push(this.block(indent + offset));
      } else {
        this.i++;
        out.push(this.inline(rest, l, indent));
      }
    }
    return out;
  }

  /**
   * Значение после «ключ:» или «- »: скаляр, flow-коллекция, ссылка, блочная строка,
   * а если пусто — вложенный блок на следующих строках.
   */
  private inline(text: string, at: Line, parentIndent: number, inMap = false): unknown {
    let rest = text;
    let anchor: string | null = null;
    let tag: string | null = null;
    for (;;) {
      const m = /^([&!])(\S*)\s*/.exec(rest);
      if (!m) break;
      if (m[1] === '&') anchor = m[2]!;
      else tag = m[2]!;
      rest = rest.slice(m[0].length);
    }
    let value = this.inlineValue(rest, at, parentIndent, inMap);
    // !!str 123 — строка, а не число.
    if (tag === '!str' && value !== null && typeof value !== 'object' && typeof value !== 'string')
      value = rest;
    if (anchor) this.anchors.set(anchor, value);
    return value;
  }

  private inlineValue(rest: string, at: Line, parentIndent: number, inMap: boolean): unknown {
    if (rest === '') {
      const next = this.line;
      if (next && next.indent > parentIndent) return this.block(next.indent);
      // compose часто пишет список вровень с ключом: ports:\n- "80:80"
      if (inMap && next && next.indent === parentIndent && isSeqItem(next.text))
        return this.seq(parentIndent);
      return null;
    }
    if (rest.startsWith('*')) {
      const name = rest.slice(1);
      if (!this.anchors.has(name)) throw new YamlError(`Нет якоря &${name}`, at.no);
      return this.anchors.get(name);
    }
    if (rest[0] === '|' || rest[0] === '>') return this.blockScalar(rest, parentIndent, at);
    if (rest[0] === '[' || rest[0] === '{') {
      let src = rest;
      while (!balanced(src)) {
        const next = this.line;
        if (!next) throw new YamlError('Скобка не закрыта', at.no);
        src += ' ' + next.text;
        this.i++;
      }
      const flow = new Flow(src, at.no, this.anchors);
      const v = flow.value();
      flow.end();
      return v;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      let src = rest;
      // Строка в кавычках может продолжаться на следующих строках.
      for (;;) {
        try {
          const q = quoted(src, 0, at.no);
          if (src.slice(q.end).trim()) throw new YamlError('Текст после закрывающей кавычки', at.no);
          return q.value;
        } catch (e) {
          const next = this.line;
          if (!(e instanceof YamlError) || !e.message.startsWith('Строка') || !next) throw e;
          src += ' ' + next.raw.trim();
          this.i++;
        }
      }
    }
    // Многострочный простой скаляр: продолжение — строки глубже родителя.
    let src = rest;
    while (this.line && this.line.indent > parentIndent && !isSeqItem(this.line.text)) {
      if (inMap && keySplit(this.line.text) >= 0) break;
      src += ' ' + this.line.text;
      this.i++;
    }
    return plain(src);
  }

  private blockScalar(header: string, parentIndent: number, at: Line): string {
    const m = /^([|>])([-+]?)(\d?)([-+]?)$/.exec(header);
    if (!m) throw new YamlError(`Непонятный заголовок блочной строки «${header}»`, at.no);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const explicit = m[3] ? parentIndent + Number(m[3]) : 0;

    // Пустые строки и строки-комментарии выкинуты из lines — берём их из исходника по номерам.
    const body: string[] = [];
    let indent = explicit;
    let lastNo = at.no;
    while (this.line && this.line.indent > parentIndent) {
      const l = this.line;
      if (!indent) indent = l.indent;
      if (l.indent < indent) break;
      for (let n = lastNo + 1; n < l.no; n++) body.push(this.src[n - 1]!.slice(indent).trimEnd());
      body.push(l.raw.slice(indent));
      lastNo = l.no;
      this.i++;
    }
    let text = folded ? fold(body) : body.join('\n');
    if (chomp === '-') return text.replace(/\n+$/, '');
    text = text.replace(/\n+$/, '') + '\n';
    if (chomp !== '+') return text === '\n' ? '' : text;
    // |+ сохраняет и пустые строки после блока, до следующего ключа.
    const nextNo = this.line?.no ?? this.src.length + (this.src.at(-1) === '' ? 0 : 1);
    let blank = 0;
    for (let n = lastNo + 1; n < nextNo && !this.src[n - 1]!.trim(); n++) blank++;
    return text + '\n'.repeat(blank);
  }
}

/** Склейка > : строки абзаца через пробел, пустая строка — перевод строки, глубже отступ — как есть. */
function fold(body: string[]): string {
  let out = '';
  body.forEach((line, i) => {
    const prev = body[i - 1];
    if (i === 0) out = line;
    else if (line === '') out += '\n';
    else if (prev === '') out += line;
    else if (/^\s/.test(line) || /^\s/.test(prev!)) out += '\n' + line;
    else out += ' ' + line;
  });
  return out;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** Flow-коллекции: [a, b, {c: d}], {a: 1, b: [x, y]}. */
class Flow {
  private p = 0;

  constructor(
    private readonly s: string,
    private readonly no: number,
    private readonly anchors: Map<string, unknown>,
  ) {}

  private ws(): void {
    while (this.p < this.s.length && /\s/.test(this.s[this.p]!)) this.p++;
  }

  private fail(msg: string): never {
    throw new YamlError(msg, this.no);
  }

  end(): void {
    this.ws();
    if (this.p < this.s.length) this.fail('Текст после закрывающей скобки');
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.p];
    let anchor: string | null = null;
    if (c === '&' || c === '!') {
      const m = /^([&!])(\S*?)(?=[\s,\]}]|$)/.exec(this.s.slice(this.p))!;
      this.p += m[0].length;
      if (m[1] === '&') anchor = m[2]!;
      const v = this.value();
      if (anchor) this.anchors.set(anchor, v);
      return v;
    }
    if (c === '[') return this.list();
    if (c === '{') return this.dict();
    if (c === '"' || c === "'") {
      const q = quoted(this.s, this.p, this.no);
      this.p = q.end;
      return q.value;
    }
    const start = this.p;
    while (this.p < this.s.length && !/[,\]}]/.test(this.s[this.p]!)) {
      if (this.s[this.p] === ':' && /[\s,\]}]/.test(this.s[this.p + 1] ?? ' ')) break;
      this.p++;
    }
    const text = this.s.slice(start, this.p).trim();
    if (text.startsWith('*')) {
      if (!this.anchors.has(text.slice(1))) this.fail(`Нет якоря &${text.slice(1)}`);
      return this.anchors.get(text.slice(1));
    }
    return plain(text);
  }

  private list(): unknown[] {
    const out: unknown[] = [];
    this.p++;
    for (;;) {
      this.ws();
      if (this.s[this.p] === ']') {
        this.p++;
        return out;
      }
      out.push(this.value());
      this.ws();
      const c = this.s[this.p];
      if (c === ',') this.p++;
      else if (c !== ']') this.fail('В списке [ ] ждали запятую или ]');
    }
  }

  private dict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const merges: unknown[] = [];
    this.p++;
    for (;;) {
      this.ws();
      if (this.s[this.p] === '}') {
        this.p++;
        for (const m of merges) applyMerge(out, m, this.no);
        return out;
      }
      const key = String(this.value() ?? '');
      this.ws();
      let v: unknown = null;
      if (this.s[this.p] === ':') {
        this.p++;
        v = this.value();
        this.ws();
      }
      if (key === MERGE) merges.push(v);
      else out[key] = v;
      const c = this.s[this.p];
      if (c === ',') this.p++;
      else if (c !== '}') this.fail('В словаре { } ждали запятую или }');
    }
  }
}

/** Разбирает YAML-документ. Бросает YamlError с номером строки. */
export function parseYaml(text: string): unknown {
  const lines: Line[] = [];
  const src = text.replace(/^﻿/, '').split(/\r?\n/);
  let started = false;
  for (let n = 0; n < src.length; n++) {
    const raw = src[n]!;
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
      if (started && raw.startsWith('---'))
        throw new YamlError('Несколько документов в одном файле не поддерживаются', n + 1);
      const after = raw.slice(3).trim();
      if (!after || after.startsWith('#')) continue;
    }
    if (/^\s*%/.test(raw) && !started) continue;
    const indentMatch = /^[ \t]*/.exec(raw)![0];
    if (indentMatch.includes('\t') && raw.trim())
      throw new YamlError('Табуляция в отступе: YAML разрешает только пробелы', n + 1);
    const content = stripComment(raw.slice(indentMatch.length));
    if (!content) continue;
    started = true;
    lines.push({ no: n + 1, indent: indentMatch.length, text: content, raw });
  }
  return new Parser(lines, src).parse();
}
