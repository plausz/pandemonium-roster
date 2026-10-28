import { dc, APP_ID, GUILD_ID } from '../lib/discord.js';
import { managedRoleMap } from '../lib/roles.js';
import { publishRoster } from '../lib/roster.js';

// Egyszeri / ismételhető beállítás: regisztrálja a /karakter parancsot és kiteszi (vagy frissíti) a roster üzenetet.
// Hívás: GET /api/setup?secret=<SETUP_SECRET>
export async function GET(request) {
  const url = new URL(request.url);
  if (!process.env.SETUP_SECRET || url.searchParams.get('secret') !== process.env.SETUP_SECRET) {
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
  ]);
  report.commands = commands.map((c) => c.name);

  const map = await managedRoleMap();
  report.missingRoles = Object.entries(map).filter(([, id]) => !id).map(([k]) => k);

  report.rosterMessageId = await publishRoster();
  return Response.json(report);
}
