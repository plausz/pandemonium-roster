import { put, get, list, del } from '@vercel/blob';

// Privát Blob tár; minden olvasás megkerüli a CDN-cache-t, így mindig a legfrissebb adatot látjuk.
const OPTS = { access: 'private' };

async function readJson(pathname) {
  const r = await get(pathname, { ...OPTS, useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  const text = await new Response(r.stream).text();
  return JSON.parse(text);
}

async function writeJson(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    ...OPTS,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
}

export const getMember = (userId) => readJson(`members/${userId}.json`);
export const saveMember = (rec) => writeJson(`members/${rec.userId}.json`, { ...rec, updatedAt: new Date().toISOString() });
export const deleteMember = (userId) => del(`members/${userId}.json`);

export async function allMembers() {
  const paths = [];
  let cursor;
  do {
    const page = await list({ prefix: 'members/', cursor, limit: 1000 });
    paths.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const recs = await Promise.all(paths.map((p) => readJson(p).catch(() => null)));
  return recs.filter(Boolean);
}

export const getConfig = async () => (await readJson('config.json')) ?? {};
export const saveConfig = (cfg) => writeJson('config.json', cfg);
