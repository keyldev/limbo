// Копирует общую спецификацию (пресеты и сценарии) из корня репозитория в public/spec,
// чтобы приложение отдавало её как статику. public/spec в .gitignore: правьте файлы в /spec.
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../../../spec');
const to = resolve(here, '../public/spec');

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.md') });
console.log(`spec → ${to}`);
