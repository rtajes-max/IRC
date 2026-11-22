import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['scripts/smoke.ts'], outfile: 'dist/smoke.js', platform: 'node', format: 'cjs' });
await build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' });

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/style.css', 'dist/renderer/style.css');
cpSync('build/icon.png', 'dist/icon.png');
