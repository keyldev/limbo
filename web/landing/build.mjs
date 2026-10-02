// Собирает лендинг в dist/: index.html как есть, demo.ts и landing.css через esbuild.
//   node build.mjs           — сборка для выкладки
//   node build.mjs --serve   — http://localhost:4300 с пересборкой при правках (доска — pnpm start в app/)
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, watch } from 'node:fs';

const serve = process.argv.includes('--serve');
const out = 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copyStatic = () => {
  copyFileSync('src/index.html', `${out}/index.html`);
  copyFileSync('../app/public/favicon.ico', `${out}/favicon.ico`);
};
copyStatic();

const options = {
  entryPoints: ['src/demo.ts', 'src/landing.css'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !serve,
  sourcemap: serve,
  outdir: out,
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  watch('src/index.html', copyStatic);
  const { port } = await ctx.serve({ servedir: out, port: 4300 });
  console.log(`Лендинг: http://localhost:${port}`);
} else {
  await esbuild.build(options);
}
