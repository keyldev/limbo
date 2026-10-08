import { describe, expect, it } from 'vitest';
import { YamlError, parseYaml } from './yaml.js';

describe('parseYaml', () => {
  it('словари, списки, скаляры core schema', () => {
    expect(
      parseYaml(`
# комментарий
name: shop
version: "3.9"
replicas: 3
ratio: 0.5
debug: false
empty:
tilde: ~
ports:
  - "80:80"
  - 443:443
image: postgres:17-alpine # тег с двоеточием
url: http://api:8080/path#frag
`),
    ).toEqual({
      name: 'shop',
      version: '3.9',
      replicas: 3,
      ratio: 0.5,
      debug: false,
      empty: null,
      tilde: null,
      ports: ['80:80', '443:443'],
      image: 'postgres:17-alpine',
      url: 'http://api:8080/path#frag',
    });
  });

  it('список вровень с ключом и словари в пунктах списка', () => {
    expect(
      parseYaml(`
services:
  api:
    ports:
    - "8080:8080"
    volumes:
      - type: bind
        source: ./Caddyfile
        target: /etc/caddy/Caddyfile
      - - nested
        - list
`),
    ).toEqual({
      services: {
        api: {
          ports: ['8080:8080'],
          volumes: [
            { type: 'bind', source: './Caddyfile', target: '/etc/caddy/Caddyfile' },
            ['nested', 'list'],
          ],
        },
      },
    });
  });

  it('flow-коллекции, в том числе на нескольких строках', () => {
    expect(
      parseYaml(`
test: ["CMD-SHELL", "pg_isready -U app"]
deps: [db, cache]
env: {A: 1, B: "x, y", C: [1, 2]}
multi: [
  one,
  two
]
empty: []
`),
    ).toEqual({
      test: ['CMD-SHELL', 'pg_isready -U app'],
      deps: ['db', 'cache'],
      env: { A: 1, B: 'x, y', C: [1, 2] },
      multi: ['one', 'two'],
      empty: [],
    });
  });

  it('кавычки и экранирование', () => {
    expect(
      parseYaml(`
a: 'it''s # not a comment'
b: "tab\\tquote\\" \\u0041"
c: it's plain # comment
"quoted key": 1
d: "split
  across lines"
`),
    ).toEqual({
      a: "it's # not a comment",
      b: 'tab\tquote" A',
      c: "it's plain",
      'quoted key': 1,
      d: 'split across lines',
    });
  });

  it('блочные строки | и > с chomping', () => {
    expect(
      parseYaml(`
script: |
  # это текст, а не комментарий
  echo one

  echo two
folded: >-
  first
  second

  third
keep: |+
  x

next: 1
`),
    ).toEqual({
      script: '# это текст, а не комментарий\necho one\n\necho two\n',
      folded: 'first second\nthird',
      keep: 'x\n\n',
      next: 1,
    });
  });

  it('якоря, ссылки и слияние <<', () => {
    expect(
      parseYaml(`
x-common: &common
  restart: unless-stopped
  environment: &env
    TZ: UTC
x-logging: &logging
  logging: { driver: json-file }
services:
  api:
    <<: [*common, *logging]
    restart: always
  worker:
    <<: *common
    environment: *env
`),
    ).toMatchObject({
      services: {
        api: { restart: 'always', environment: { TZ: 'UTC' }, logging: { driver: 'json-file' } },
        worker: { restart: 'unless-stopped', environment: { TZ: 'UTC' } },
      },
    });
  });

  it('теги compose пропускаются, --- в начале допускается', () => {
    expect(parseYaml('---\nports: !reset []\nimage: !!str 123\n')).toEqual({
      ports: [],
      image: '123',
    });
  });

  it('ошибки с номером строки', () => {
    const err = (src: string): YamlError => {
      try {
        parseYaml(src);
      } catch (e) {
        return e as YamlError;
      }
      throw new Error('ждали ошибку');
    };
    expect(err('a: 1\n\tb: 2').line).toBe(2);
    expect(err('a: [1, 2\n').message).toMatch(/Скобка не закрыта/);
    expect(err('a: *missing').message).toMatch(/Нет якоря/);
    expect(err('a: 1\n    b: 2').message).toMatch(/Лишний отступ/);
    expect(err('a: 1\n---\nb: 2').message).toMatch(/Несколько документов/);
  });
});
