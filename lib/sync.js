import { getGuild, saveGuild } from './store.js';
import { blizzardEnabled, fetchGuild } from './blizzard.js';

// Blizzard guild-szinkron. A napi karbantartás mindig lefuttatja; a #roster 🔄 gombja csak akkor, ha a legutóbbi
// szinkron régebbi, mint minAgeMs (így a gomb nyomkodása nem terheli feleslegesen a Blizzard API-t).
// Visszaad: rövid összefoglaló szöveg. Hiba esetén a korábbi adatok maradnak.
export async function syncGuild({ minAgeMs = 0 } = {}) {
  if (!blizzardEnabled()) return 'kikapcsolva';
  if (minAgeMs > 0) {
    const prev = await getGuild().catch(() => null);
    if (prev?.syncedAt && Date.now() - Date.parse(prev.syncedAt) < minAgeMs) return 'friss (kihagyva)';
  }
  try {
    const g = await fetchGuild();
    await saveGuild(g);
    return `${g.members.length} karakter, ebből ${g.members.filter((m) => m.ilvl != null).length} item levellel, ${g.members.filter((m) => m.level >= 10).length} legalább 10. szintű`;
  } catch (e) {
    console.error('guild sync', e);
    return `hiba: ${e.message}`;
  }
}
