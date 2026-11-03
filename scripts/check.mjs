import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}
const files = await walk(path.join(root, 'extension'));
for (const file of files.filter(file => file.endsWith('.js'))) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(checked.stderr);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) await stat(path.resolve(path.dirname(file), match[1]));
}
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest must use MV3.');
await stat(path.join(root, 'extension', manifest.background.service_worker));
await stat(path.join(root, 'extension', manifest.side_panel.default_path));
const html = await readFile(path.join(root, 'extension', manifest.side_panel.default_path), 'utf8');
if (/<script(?![^>]*src=)[^>]*>\s*\S/i.test(html)) throw new Error('Inline scripts violate extension CSP.');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (!/^https?:/.test(match[1])) await stat(path.resolve(root, 'extension/panel', match[1]));
}
console.log(`Validated Manifest V3, local assets, module imports, and syntax for ${files.length} extension files.`);
