import { dc, APP_ID, GUILD_ID } from '../lib/discord.js';
import { managedRoleMap } from '../lib/roles.js';
import { publishRoster } from '../lib/roster.js';

// Egyszeri / ismételhető beállítás: regisztrálja a /karakter parancsot és kiteszi (vagy frissíti) a roster üzenetet.
// Hívás: GET /api/setup (ha SETUP_SECRET be van állítva: /api/setup?secret=<SETUP_SECRET>).
// Idempotens: újra meghívva csak felülírja ugyanazt a parancsot és frissíti ugyanazt a roster üzenetet.
export async function GET(request) {
  const url = new URL(request.url);
  if (process.env.SETUP_SECRET && url.searchParams.get('secret') !== process.env.SETUP_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  const report = {};
  const commands = await dc('PUT', `/applications/${APP_ID()}/guilds/${GUILD_ID()}/commands`, [
    {
      name: 'karakter',
      description: 'Add meg vagy módosítsd a main és alt karaktered (szerep, class, spec, offspec)',
      type: 1,
      dm_permission: false,
    },
    // Officereknek (Rangok kezelése jog): más tag roster-adatainak megadása / módosítása.
    {
      name: 'roster-admin',
      description: 'Egy tag roster-adatainak megadása vagy módosítása (officereknek)',
      type: 1,
      dm_permission: false,
      default_member_permissions: String(1 << 28),
      options: [{ type: 6, name: 'tag', description: 'Akinek a karaktereit szerkeszted', required: true }],
    },
    // Officereknek: a Blizzard guild-listából a rosterben nem szereplő karakterek hozzárendelése tagokhoz.
    {
      name: 'parositas',
      description: 'Guildkarakterek párosítása tagokhoz, emlékeztető a ki nem töltötteknek (officereknek)',
      type: 1,
      dm_permission: false,
      default_member_permissions: String(1 << 28),
      options: [{ type: 3, name: 'nev', description: 'Keresés a karakternevek között (névrészlet, ékezet nélkül is)', required: false, max_length: 40 }],
    },
    // Ugyanez jobb klikkel: tag → Alkalmazások → Roster szerkesztése
    { name: 'Roster szerkesztése', type: 2, dm_permission: false, default_member_permissions: String(1 << 28) },
  ]);
  report.commands = commands.map((c) => c.name);

  const map = await managedRoleMap();
  report.missingRoles = Object.entries(map).filter(([, id]) => !id).map(([k]) => k);

  report.rosterMessageId = await publishRoster();
  return Response.json(report);
}
