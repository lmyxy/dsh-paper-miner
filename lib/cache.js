// Content-addressed cache so a paper is parsed once and every later question
// costs disk reads instead of PDF work.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORMAT_VERSION = 6;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function cacheFile(cacheDir, sha) {
  return path.join(cacheDir, `${sha.slice(0, 32)}.json.gz`);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readCache(cacheDir, sha) {
  const file = cacheFile(cacheDir, sha);
  try {
    const raw = await fs.readFile(file);
    const json = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    if (json.v !== FORMAT_VERSION) return undefined;
    return json;
  } catch {
    return undefined;
  }
}

export async function writeCache(cacheDir, sha, record) {
  await ensureDir(cacheDir);
  const payload = { ...record, v: FORMAT_VERSION };
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 });
  const file = cacheFile(cacheDir, sha);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, raw);
  await fs.rename(temp, file);
  return file;
}

/** Human-readable cache inventory. */
export async function listCache(cacheDir) {
  if (!existsSync(cacheDir)) return [];
  const entries = [];
  for (const name of await fs.readdir(cacheDir)) {
    if (!name.endsWith('.json.gz')) continue;
    const file = path.join(cacheDir, name);
    try {
      const stat = await fs.stat(file);
      const json = JSON.parse(zlib.gunzipSync(await fs.readFile(file)).toString('utf8'));
      entries.push({
        key: name.replace('.json.gz', ''),
        file,
        bytes: stat.size,
        path: json.sourcePath,
        title: json.title,
        pages: json.pageCount,
        chars: json.totalChars,
        createdAt: json.createdAt,
      });
    } catch {
      // Unreadable cache files are ignored rather than failing the call.
    }
  }
  entries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return entries;
}

export async function purgeCache(cacheDir, key) {
  const entries = await listCache(cacheDir);
  const removed = [];
  for (const entry of entries) {
    if (key !== undefined && entry.key !== key && entry.key !== key.slice(0, 32)) continue;
    try {
      await fs.unlink(entry.file);
      removed.push(entry.key);
    } catch {
      // A concurrent purge may already have removed it.
    }
  }
  return removed;
}
