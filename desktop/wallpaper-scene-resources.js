'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const allowed = new Set('.pkg .pak .json .tex .mdl .js .vert .frag .h .glsl .png .jpg .jpeg .webp .gif .mp4 .webm .wav .ogg .mp3 .ttf .otf .woff .woff2'.split(' '));
const inside = (root, target) => { const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

class SceneResources {
  constructor(library, steamLibraries) {
    this.library = library;
    this.steamLibraries = steamLibraries;
    this.sessions = new Map();
    this.generation = 0;
  }
  async open(id) {
    const generation = this.generation;
    const target = await this.library.getNativeSceneTarget(id);
    const projectRoot = await fs.realpath(path.dirname(target.projectFile));
    const manifest = JSON.parse((await fs.readFile(target.projectFile, 'utf8')).replace(/^\uFEFF/, ''));
    const stat = await fs.stat(target.scenePackage);
    if (stat.size > 512 * 1024 ** 2) throw new Error('SCENE_PACKAGE_TOO_LARGE');
    let builtinRoot = '';
    for (const steam of await this.steamLibraries()) {
      try { builtinRoot = await fs.realpath(path.join(steam, 'steamapps/common/wallpaper_engine/assets')); break; } catch (_) {}
    }
    const sessionId = crypto.randomBytes(24).toString('hex');
    if (generation !== this.generation) throw new Error('SCENE_SESSION_CLOSED');
    this.sessions.set(sessionId, { projectRoot, builtinRoot, activeBytes: 0, readers: 0 });
    return { sessionId, project: manifest, packagePath: path.relative(projectRoot, target.scenePackage).replaceAll('\\', '/'),
      key: id + ':' + stat.size + ':' + stat.mtimeMs, hasBuiltins: !!builtinRoot };
  }
  close(id) { this.sessions.delete(id); }
  closeAll() { this.generation++; this.sessions.clear(); }
  async read(id, namespace, rel) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SCENE_SESSION_CLOSED');
    if (namespace !== 'project' && namespace !== 'builtin') throw new Error('SCENE_NAMESPACE_INVALID');
    if (typeof rel !== 'string' || !rel || /[\\:%\x00-\x1f]/.test(rel) || rel.split('/').some(x => !x || x === '.' || x === '..') || !allowed.has(path.extname(rel).toLowerCase())) throw new Error('SCENE_PATH_DENIED');
    if (namespace === 'builtin' && !/^(materials\/.*\.tex|fonts\/.*\.(ttf|otf|woff2?))$/i.test(rel)) throw new Error('SCENE_BUILTIN_DENIED');
    const root = namespace === 'project' ? session.projectRoot : session.builtinRoot;
    if (!root) return null;
    let file;
    try { file = await fs.realpath(path.resolve(root, rel)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!inside(root, file)) throw new Error('SCENE_PATH_DENIED');
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('SCENE_NOT_FILE');
    const limit = /\.(pkg|pak)$/i.test(rel) ? 512 : 128;
    if (stat.size > limit * 1024 ** 2 || session.activeBytes + stat.size > 512 * 1024 ** 2 || session.readers >= 4) throw new Error('SCENE_RESOURCE_LIMIT');
    session.activeBytes += stat.size;
    session.readers++;
    try {
      const data = await fs.readFile(file);
      if (this.sessions.get(id) !== session) throw new Error('SCENE_SESSION_CLOSED');
      return data;
    } finally { session.activeBytes -= stat.size; session.readers--; }
  }
  async builtinNames(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SCENE_SESSION_CLOSED');
    if (!session.builtinRoot) return [];
    const names = [];
    const root = path.join(session.builtinRoot, 'materials');
    const walk = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (names.length > 10000) throw new Error('SCENE_BUILTIN_LIMIT');
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + '/');
        else if (entry.name.endsWith('.tex')) names.push(prefix + entry.name.slice(0, -4));
      }
    };
    await walk(root);
    if (this.sessions.get(id) !== session) throw new Error('SCENE_SESSION_CLOSED');
    return names;
  }
}
module.exports = { SceneResources };
