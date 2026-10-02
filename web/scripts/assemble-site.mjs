// Складывает сайт для статического хостинга в web/dist/site:
//   /      — лендинг (landing/dist)
//   /app/  — доска (app/dist/app/browser, собранная с baseHref /app/)
// Перед запуском: pnpm build (или сборка с адресом API, см. deploy-web.yml).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const landing = resolve(web, 'landing/dist');
const app = resolve(web, 'app/dist/app/browser');
const site = resolve(web, 'dist/site');

for (const dir of [landing, app]) {
  if (!existsSync(dir)) throw new Error(`Нет сборки ${dir}: сначала pnpm build`);
}
rmSync(site, { recursive: true, force: true });
cpSync(landing, site, { recursive: true });
cpSync(app, resolve(site, 'app'), { recursive: true });
console.log(`сайт → ${site}`);
