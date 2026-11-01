import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, process.argv[2] || 'tmp/wallpaper-scene-perf/upstream');
const revision = '197abe54266c31d346cebc314e49a26b70c960cc';
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== revision) throw new Error('Unsupported WebWallGL revision');
const patchedPaths = ['renderer/src/api/mount.ts', 'renderer/src/local-assets.ts'];
const dirty = execFileSync('git', ['diff', '--name-only', revision], { cwd: source, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
if (dirty.some(file => !patchedPaths.includes(file))) throw new Error('Unexpected upstream source changes');
for (const [name, version] of [['mediabunny', '1.56.0'], ['vite', '6.4.3'], ['esbuild', '0.28.2']]) {
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'node_modules', name, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`Unexpected ${name} version: ${pkg.version}`);
}
const require = createRequire(import.meta.url);
const { patchMountOptions, patchLocalAssets } = require('./wallpaper-scene-vendor-patch');
for (const [rel, patch] of [['renderer/src/api/mount.ts', patchMountOptions], ['renderer/src/local-assets.ts', patchLocalAssets]]) {
  const file = path.join(source, rel);
  const original = execFileSync('git', ['show', `${revision}:${rel}`], { cwd: source, encoding: 'utf8' });
  const expected = patch(original);
  const actual = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  if (actual !== original && actual !== expected) throw new Error(`Unexpected edits in ${rel}`);
  await fs.writeFile(file, expected);
}
execFileSync(process.execPath, ['scripts/build-lib.mjs'], { cwd: source, stdio: 'inherit' });
const { transform } = await import(pathToFileURL(path.join(source, 'node_modules/esbuild/lib/main.js')));
const bundle = await transform(await fs.readFile(path.join(source, 'dist/lib/webwallgl.global.js'), 'utf8'), { minify: true, legalComments: 'eof' });
const output = path.join(root, 'public/vendor/webwallgl');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'webwallgl.global.min.js'), bundle.code);
for (const [src, dest] of [['LICENSE', 'LICENSE'], ['renderer/vendor/we-scene/LICENSE', 'LICENSE-we-scene'], ['node_modules/mediabunny/LICENSE', 'LICENSE-mediabunny']]) await fs.copyFile(path.join(source, src), path.join(output, dest));
await fs.writeFile(path.join(output, 'SOURCE.json'), JSON.stringify({ repository: 'https://github.com/oneincase/webwallgl', revision, sha256: createHash('sha256').update(bundle.code).digest('hex'), patches: ['mount options autoQuality/bake forwarding', 'module-local asset fetch routed through isolated host bridge', 'required stock textures fail closed when missing or undecodable'], mediabunny: { version: '1.56.0', license: 'MPL-2.0', source: 'https://registry.npmjs.org/mediabunny/-/mediabunny-1.56.0.tgz' } }, null, 2) + '\n');
