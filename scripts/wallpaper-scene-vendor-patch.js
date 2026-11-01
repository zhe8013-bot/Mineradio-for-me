'use strict';

// Pinned WebWallGL 3.0.0 declares these options but drops them before mounting.
function patchMountOptions(source) {
  const marker = '    quality: o.quality,';
  const replacement = marker + '\n    autoQuality: o.autoQuality,\n    bake: o.bake,';
  if (source.includes(replacement)) return source;
  if (source.split(marker).length !== 2) throw new Error('Unsupported WebWallGL mount source');
  return source.replace(marker, replacement);
}

function patchLocalAssets(source) {
  if (source.includes('function mineradioAssetFetch(')) return source;
  if (!source.includes('const BASE = "/api/local-assets";')) throw new Error('Unsupported WebWallGL local assets source');
  const header = 'export async function ensureLocalAsset(name: string): Promise<boolean> {';
  const stock = '/^(util|particle|gradient|lut|pattern|cookie)\\//.test(name)';
  source = source.replace(header, header + '\n  if (' + stock + ' && (!source || !source.names.has(name))) throw new Error("SCENE_STOCK_TEXTURE_MISSING: " + name);');
  source = source.replace('  if (!px) return false;', '  if (!px) { if (' + stock + ') throw new Error("SCENE_STOCK_TEXTURE_DECODE_FAILED: " + name); return false; }');
  return source.replace(/\bfetch\(/g, 'mineradioAssetFetch(') + '\nfunction mineradioAssetFetch(url: string, _init?: unknown): Promise<Response> {\n  const reader = (globalThis as any).__mineradioAssetFetch;\n  if (!reader) return Promise.reject(new Error("SCENE_ASSET_BRIDGE_MISSING"));\n  return reader(url);\n}\n';
}
module.exports = { patchMountOptions, patchLocalAssets };
