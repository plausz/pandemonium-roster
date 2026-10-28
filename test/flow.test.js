import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// --- Teszt-környezet: Ed25519 kulcspár, memóriás tár, hamis Discord API ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
Object.assign(process.env, {
  DISCORD_PUBLIC_KEY: rawPub, DISCORD_TOKEN: 'x', DISCORD_APP_ID: 'app', GUILD_ID: 'g1',
  ROSTER_CHANNEL_ID: 'roster', CRON_SECRET: 'cron', SETUP_SECRET: 'setup',
});

const db = new Map();
const pending = [];
mock.module('@vercel/functions', { namedExports: { waitUntil: (p) => pending.push(p) } });
mock.module('../lib/store.js', {
  namedExports: {
    getMember: async (id) => db.get(`m/${id}`) ?? null,
    saveMember: async (r) => db.set(`m/${r.userId}`, structuredClone(r)),
    deleteMember: async (id) => db.delete(`m/${id}`),
    allMembers: async () => [...db].filter(([k]) => k.startsWith('m/')).map(([, v]) => v),
    getConfig: async () => db.get('cfg') ?? {},
    saveConfig: async (c) => db.set('cfg', c),
  },
});

const ROLES = [
  ['r-tank', '🛡️ Tank'], ['r-heal', '💚 Healer'], ['r-dps', '🗡️ DPS'],
  ...['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'].map((n) => [`c-${n}`, n]),
  ['panda', 'Panda'], ['friends', 'Friends'],
].map(([id, name]) => ({ id, name }));
const MEMBERS = [
  { user: { id: 'u1', username: 'plausz' }, nick: 'Plausz', roles: ['panda', 'r-dps'] },
  { user: { id: 'u2', username: 'zulu' }, roles: ['panda'] },
  { user: { id: 'u3', username: 'haver' }, roles: ['friends'] },
];
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = url.replace('https://discord.com/api/v10', '');
  calls.push(`${init.method} ${path}`);
  const body = init.body ? JSON.parse(init.body) : null;
  if (path.endsWith('/roles')) return Response.json(ROLES);
  if (path.includes('/members?')) return Response.json(MEMBERS);
  if (path.startsWith('/channels/roster/messages') && init.method === 'POST') { calls.lastRoster = body; return Response.json({ id: 'msg1' }); }
  if (path.startsWith('/channels/roster/messages/')) { calls.lastRoster = body; return Response.json({ id: 'msg1' }); }
  if (path.startsWith('/webhooks/')) { calls.lastEdit = body; return Response.json({}); }
  if (path.includes('/members/') && path.includes('/roles/')) return new Response(null, { status: 204 });
  if (path.includes('/commands')) return Response.json(body);
  throw new Error('unexpected ' + path);
};

const { POST } = await import('../api/interactions.js');

function signed(payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  return new Request('https://x/api/interactions', { method: 'POST', body, headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts } });
}
const member = { user: { id: 'u1', username: 'plausz' }, nick: 'Plausz', roles: ['panda', 'r-dps'] };
const base = { guild_id: 'g1', token: 'tok', member };
const click = (custom_id, values, ephemeral = true) => signed({ ...base, type: 3, data: { custom_id, values }, message: { flags: ephemeral ? 64 : 0 } });
const drain = async () => { while (pending.length) await pending.shift(); };

test('rossz aláírás elutasítva, PING → PONG', async () => {
  const bad = new Request('https://x', { method: 'POST', body: '{}', headers: { 'x-signature-ed25519': '00', 'x-signature-timestamp': '1' } });
  assert.equal((await POST(bad)).status, 401);
  assert.deepEqual(await (await POST(signed({ type: 1 }))).json(), { type: 1 });
});

test('teljes main + alt folyamat, rangok és roster', async () => {
  let r = await (await POST(signed({ ...base, type: 2, data: { name: 'karakter' } }))).json();
  assert.equal(r.type, 4);
  assert.equal(r.data.flags, 64);
  assert.equal(r.data.components[0].components[0].custom_id, 'w:m:start');

  r = await (await POST(click('w:m:start'))).json();
  assert.equal(r.type, 7);
  r = await (await POST(click('w:m:r', ['T']))).json();
  const classOpts = r.data.components[0].components[0].options.map((o) => o.label);
  assert.deepEqual(classOpts, ['Warrior', 'Paladin', 'Druid'], 'tankként csak tankolni képes classok');

  // Warrior tankként: egyetlen spec (Protection) → a specválasztás kimarad, rögtön az offspec jön
  r = await (await POST(click('w:m:c:T', ['0']))).json();
  assert.match(r.data.embeds[0].title, /offspec/);
  const offOpts = r.data.components[0].components[0].options.map((o) => o.value);
  assert.deepEqual(offOpts, ['0', '1', 'x']);
  assert.equal(r.data.components[0].components[0].custom_id, 'w:m:o:T:0:2');

  r = await (await POST(click('w:m:o:T:0:2', ['1']))).json();
  assert.match(r.data.embeds[0].description, /Protection Warrior · off: Fury/);

  // Név megadása modallal
  r = await (await POST(click('n:m:T:0:2:1'))).json();
  assert.equal(r.type, 9);
  r = await (await POST(signed({ ...base, type: 5, data: { custom_id: 'm:m:T:0:2:1', components: [{ type: 1, components: [{ type: 4, custom_id: 'name', value: '  Lewarrina ' }] }] }, message: { flags: 64 } }))).json();
  assert.equal(r.type, 7);
  assert.equal(r.data.flags, undefined, 'frissítéskor nem küldünk flags mezőt');
  await drain();

  assert.deepEqual(db.get('m/u1').main, { role: 'T', cls: 0, spec: 2, off: 1, name: 'Lewarrina' });
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/r-tank'));
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/c-Warrior'));
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/r-dps') === false, 'a meglévő DPS rangot nem adja újra');
  assert.ok(!calls.includes('DELETE /guilds/g1/members/u1/roles/r-dps'), 'a Fury offspec miatt a DPS marad');
  assert.match(calls.lastEdit.embeds[0].description, /Mentve/);
  assert.equal(calls.lastEdit.flags, undefined);
  const roster = calls.lastRoster.embeds[0].description;
  assert.match(roster, /Tank: \*\*1\*\*/);
  assert.match(roster, /Plausz.*Protection Warrior/);
  assert.match(roster, /Még nem töltötte ki \(1\):\** zulu/);

  // Alt: Healer Druid → Restoration (egyetlen healer spec) → nincs offspec → mentés név nélkül
  r = await (await POST(click('w:a:r', ['H']))).json();
  r = await (await POST(click('w:a:c:H', ['8']))).json();
  assert.equal(r.data.components[0].components[0].custom_id, 'w:a:o:H:8:3');
  r = await (await POST(click('w:a:o:H:8:3', ['x']))).json();
  r = await (await POST(click('v:a:H:8:3:x'))).json();
  await drain();
  assert.deepEqual(db.get('m/u1').alt, { role: 'H', cls: 8, spec: 3, off: null, name: null });
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/c-Druid'));
  assert.match(calls.lastRoster.embeds[0].description, /alt: 💚 Restoration Druid/);
});

test('érvénytelen kombináció elutasítva (Priest tank)', async () => {
  const r = await (await POST(click('v:m:T:4:0:x'))).json();
  assert.match(r.data.embeds[0].title, /Hiba/);
});

test('roster gombjáról új ephemeral üzenet jön', async () => {
  const r = await (await POST(click('menu:home', undefined, false))).json();
  assert.equal(r.type, 4);
  assert.equal(r.data.flags, 64);
});

test('adatok törlése leveszi a kezelt rangokat', async () => {
  calls.length = 0;
  member.roles = ['panda', 'r-tank', 'r-dps', 'c-Warrior', 'c-Druid'];
  await POST(click('menu:delall2'));
  await drain();
  assert.equal(db.get('m/u1'), undefined);
  for (const id of ['r-tank', 'r-dps', 'c-Warrior', 'c-Druid']) assert.ok(calls.includes(`DELETE /guilds/g1/members/u1/roles/${id}`), id);
  assert.ok(!calls.some((c) => c.includes('/roles/panda')), 'a klánranghoz nem nyúl');
});

test('cron: kilépett tag adatai törlődnek', async () => {
  db.set('m/u9', { userId: 'u9', main: { role: 'D', cls: 6, spec: 0, off: null, name: null } });
  const { GET } = await import('../api/cron.js');
  assert.equal((await GET(new Request('https://x/api/cron'))).status, 401);
  const r = await (await GET(new Request('https://x/api/cron', { headers: { authorization: 'Bearer cron' } }))).json();
  assert.equal(r.removed, 1);
  assert.equal(db.get('m/u9'), undefined);
});
