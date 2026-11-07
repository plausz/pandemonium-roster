import { classByBlizzardId } from './data.js';

// Hivatalos Blizzard API (WoW: Forever, EU). Csak akkor fut, ha a BLIZZARD_CLIENT_ID és a BLIZZARD_CLIENT_SECRET
// be van állítva (develop.battle.net → API Access → kliens). Client credentials tokennel a guild tagjait és a
// karakterek nyilvános profilját (szint, item level) olvassuk.
// Forever sajátosságok: nincsenek realmok (helyettük ruleset), a karakter azonosítója „nev-vezeteknev”,
// a karakterek csak 10. szinttől és kilépés után jelennek meg az API-ban.
const REGION = 'eu';
const NAMESPACE = `profile-forever-${REGION}`;
const API = `https://${REGION}.api.blizzard.com`;

export const blizzardEnabled = () => !!(process.env.BLIZZARD_CLIENT_ID && process.env.BLIZZARD_CLIENT_SECRET);

let token; // { value, expires }
async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${process.env.BLIZZARD_CLIENT_ID}:${process.env.BLIZZARD_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Blizzard token → ${res.status} ${await res.text()}`);
  const j = await res.json();
  token = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API}${path}${sep}namespace=${NAMESPACE}&locale=en_GB`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blizzard ${path} → ${res.status}`);
  return res.json();
}

// A guild azonosítója: kisbetűs név, szóköz helyett kötőjel (a Pändemonium ékezetes). Ha az ékezetes alak nem
// található, az ékezet nélkülit is megpróbáljuk.
const slugify = (s) => s.trim().toLocaleLowerCase('en').replace(/\s+/g, '-');
export const charSlug = (name, surname) => slugify(surname ? `${name} ${surname}` : name);

async function guildRoster() {
  const name = process.env.BLIZZARD_GUILD || 'Pändemonium';
  const candidates = [...new Set([slugify(name), slugify(name.normalize('NFD').replace(/\p{M}/gu, ''))])];
  for (const slug of candidates) {
    const r = await api(`/data/wow/guild/${encodeURIComponent(slug)}/roster`);
    if (r) return { slug, roster: r };
  }
  throw new Error(`A guild nem található a Blizzard API-ban: ${candidates.join(', ')}`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

// A guild tagjai a profiljukkal: [{ name, slug, level, cls (a mi class-indexünk vagy -1), rank, ilvl }]
export async function fetchGuild() {
  const { slug: guildSlug, roster } = await guildRoster();
  const members = (roster.members ?? []).map((m) => {
    const c = m.character ?? {};
    const full = [c.name, c.surname].filter(Boolean).join(' ');
    return {
      name: full || c.name || '?',
      slug: c.slug ?? charSlug(c.name ?? '', c.surname),
      level: c.level ?? null,
      cls: classByBlizzardId(c.playable_class?.id),
      rank: m.rank ?? null,
      ilvl: null,
    };
  });
  // Item level a karakterprofilból (csak 10. szint felett létezik a profil).
  const profiles = await mapLimit(members, 8, (m) => (m.level >= 10 ? api(`/profile/wow/character/${encodeURIComponent(m.slug)}`) : Promise.resolve(null)));
  profiles.forEach((p, i) => {
    if (!p) return;
    members[i].ilvl = p.equipped_item_level ?? p.average_item_level ?? null;
    members[i].level = p.level ?? members[i].level;
    if (members[i].cls < 0 && p.character_class?.id) members[i].cls = classByBlizzardId(p.character_class.id);
  });
  return { guildSlug, syncedAt: new Date().toISOString(), members };
}
