import { publishRoster } from '../lib/roster.js';
import { allMembers, deleteMember } from '../lib/store.js';
import { listMembers } from '../lib/discord.js';

// Napi karbantartás (Vercel Cron): a szerverről kilépett tagok adatait törli, majd újraépíti a rostert.
// Ha a CRON_SECRET be van állítva, a Vercel Cron azt küldi, és csak azzal fogadjuk el. Enélkül is biztonságos:
// csak a már kilépett tagok adatai törlődnek, és a roster újraépül.
export async function GET(request) {
  if (process.env.CRON_SECRET && request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const [records, members] = await Promise.all([allMembers(), listMembers()]);
  const present = new Set(members.map((m) => m.user.id));
  const gone = records.filter((r) => !present.has(r.userId));
  for (const r of gone) await deleteMember(r.userId);
  await publishRoster();
  return Response.json({ ok: true, records: records.length, removed: gone.length });
}
