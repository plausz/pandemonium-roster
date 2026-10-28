import { CLASSES, ROLES } from './data.js';
import { dc, guildRoles, GUILD_ID } from './discord.js';

// A bot által kezelt rangok: a 3 szerep-rang és a 9 class-rang (név alapján keresve).
export async function managedRoleMap() {
  const roles = await guildRoles();
  const byName = (pred) => roles.find((r) => pred(r.name))?.id;
  const map = {};
  for (const [code, r] of Object.entries(ROLES)) map[`role:${code}`] = byName((n) => n.replace(/[^\p{L}\s]/gu, '').trim() === r.match);
  for (const c of CLASSES) map[`class:${c.name}`] = byName((n) => n.trim() === c.name);
  return map;
}

export function desiredKeys(rec) {
  const keys = new Set();
  if (rec?.main) {
    keys.add(`role:${rec.main.role}`);
    if (rec.main.off != null) keys.add(`role:${CLASSES[rec.main.cls].specs[rec.main.off][1]}`);
    keys.add(`class:${CLASSES[rec.main.cls].name}`);
  }
  const alts = rec?.alts ?? (rec?.alt ? [rec.alt] : []);
  for (const a of alts) keys.add(`class:${CLASSES[a.cls].name}`);
  return keys;
}

// A tag kezelt rangjait a rekordhoz igazítja; csak a különbségeket küldi el.
export async function syncRoles(userId, currentRoleIds, rec) {
  const map = await managedRoleMap();
  const want = new Set([...desiredKeys(rec)].map((k) => map[k]).filter(Boolean));
  const managed = new Set(Object.values(map).filter(Boolean));
  const have = new Set(currentRoleIds.filter((id) => managed.has(id)));
  const reason = 'Roster bot: /karakter';
  const ops = [];
  for (const id of want) if (!have.has(id)) ops.push(['PUT', id]);
  for (const id of have) if (!want.has(id)) ops.push(['DELETE', id]);
  for (const [m, id] of ops) await dc(m, `/guilds/${GUILD_ID()}/members/${userId}/roles/${id}`, null, { reason });
  return ops.length;
}
