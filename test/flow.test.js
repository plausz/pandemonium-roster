import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// --- Teszt-környezet: Ed25519 kulcspár, memóriás tár, hamis Discord API ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
Object.assign(process.env, {
  DISCORD_PUBLIC_KEY: rawPub, DISCORD_TOKEN: 'x', DISCORD_APP_ID: 'app', GUILD_ID: 'g1',
  ROSTER_CHANNEL_ID: 'roster', CRON_SECRET: 'cron',
});

const db = new Map();
const pending = [];
mock.module('@vercel/functions', { namedExports: { waitUntil: (p) => pending.push(p) } });
mock.module('../lib/store.js', {
  namedExports: {
    getMember: async (id) => structuredClone(db.get(`m/${id}`) ?? null),
    saveMember: async (r) => db.set(`m/${r.userId}`, structuredClone(r)),
    deleteMember: async (id) => db.delete(`m/${id}`),
    allMembers: async () => [...db].filter(([k]) => k.startsWith('m/')).map(([, v]) => structuredClone(v)),
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
const messages = {};
let nextMsg = 1;
globalThis.fetch = async (url, init = {}) => {
  const path = url.replace('https://discord.com/api/v10', '');
  calls.push(`${init.method} ${path}`);
  const body = init.body ? JSON.parse(init.body) : null;
  if (path.endsWith('/roles')) return Response.json(ROLES);
  if (path.includes('/members?')) return Response.json(MEMBERS);
  if (path === '/channels/roster/messages' && init.method === 'POST') { const id = `msg${nextMsg++}`; messages[id] = body; return Response.json({ id }); }
  if (path.startsWith('/channels/roster/messages/')) { messages[path.split('/').pop()] = body; return Response.json({}); }
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
const mainRoster = () => messages[db.get('cfg').rosterMessageId].embeds[0].description;
const altRoster = () => messages[db.get('cfg').altMessageId].embeds[0];
const send = async (req) => (await POST(req)).json();

async function addChar(slot, role, cls, spec, off) {
  let r = await send(click(`w:${slot}:start`));
  assert.equal(r.type, 7);
  r = await send(click(`w:${slot}:r`, [role]));
  r = await send(click(`w:${slot}:c:${role}`, [String(cls)]));
  if (r.data.embeds[0].title.includes('main spec')) r = await send(click(`w:${slot}:p:${role}:${cls}`, [String(spec)]));
  r = await send(click(`w:${slot}:o:${role}:${cls}:${spec}`, [String(off)]));
  assert.equal(r.type, 6, 'az összegzés halasztott válasszal jön');
  await drain();
  assert.match(calls.lastEdit.embeds[0].title, /összegzés/);
  const save = calls.lastEdit.components[0].components[1].custom_id;
  await send(click(save));
  await drain();
}

test('rossz aláírás elutasítva, PING → PONG', async () => {
  const bad = new Request('https://x', { method: 'POST', body: '{}', headers: { 'x-signature-ed25519': '00', 'x-signature-timestamp': '1' } });
  assert.equal((await POST(bad)).status, 401);
  assert.deepEqual(await send(signed({ type: 1 })), { type: 1 });
});

test('/karakter halasztott ephemeral válasszal indul', async () => {
  const r = await send(signed({ ...base, type: 2, data: { name: 'karakter' } }));
  assert.deepEqual(r, { type: 5, data: { flags: 64 } });
  await drain();
  assert.equal(calls.lastEdit.components[0].components[0].custom_id, 'w:m:start');
  assert.equal(calls.lastEdit.flags, undefined);
});

test('main mentése névvel, rangok és fő roster', async () => {
  let r = await send(click('w:m:r', ['T']));
  assert.deepEqual(r.data.components[0].components[0].options.map((o) => o.label), ['Warrior', 'Paladin', 'Druid']);
  // Warrior tankként: egyetlen spec → rögtön az offspec jön
  r = await send(click('w:m:c:T', ['0']));
  assert.equal(r.data.components[0].components[0].custom_id, 'w:m:o:T:0:2');
  await send(click('w:m:o:T:0:2', ['1']));
  await drain();
  assert.match(calls.lastEdit.embeds[0].description, /Protection Warrior · off: Fury/);
  const nameBtn = calls.lastEdit.components[0].components[0].custom_id;
  assert.equal(nameBtn, 'n:m:T:0:2:1|');
  r = await send(click(nameBtn));
  assert.equal(r.type, 9, 'a névablak tárolt adat olvasása nélkül, azonnal nyílik');
  r = await send(signed({ ...base, type: 5, data: { custom_id: 'm:m:T:0:2:1', components: [{ type: 1, components: [{ type: 4, custom_id: 'name', value: '  Lewarrina ' }] }] }, message: { flags: 64 } }));
  assert.equal(r.type, 7);
  await drain();
  assert.deepEqual(db.get('m/u1').main, { role: 'T', cls: 0, spec: 2, off: 1, name: 'Lewarrina' });
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/r-tank'));
  assert.ok(calls.includes('PUT /guilds/g1/members/u1/roles/c-Warrior'));
  assert.ok(!calls.includes('DELETE /guilds/g1/members/u1/roles/r-dps'), 'a Fury offspec miatt a DPS marad');
  assert.match(calls.lastEdit.embeds[0].description, /Mentve/);
  assert.match(mainRoster(), /Tank: \*\*1\*\*/);
  assert.match(mainRoster(), /Plausz.*Protection Warrior/);
  assert.match(mainRoster(), /Még nem töltötte ki \(1\):\** zulu/);
  assert.equal(messages[db.get('cfg').rosterMessageId].components.length, 0);
  assert.equal(messages[db.get('cfg').altMessageId].components[0].components[0].custom_id, 'menu:home', 'a gombok az alt roster alatt vannak');
  // A meglévő név a következő módosításnál előtöltődik
  await send(click('w:m:o:T:0:2', ['x']));
  await drain();
  assert.equal(calls.lastEdit.components[0].components[1].custom_id, 'v:m:T:0:2:x|Lewarrina');
});

test('4 alt, ötödik nem adható, alt roster, egy alt törlése', async () => {
  member.roles = ['panda', 'r-tank', 'r-dps', 'c-Warrior'];
  await addChar('a0', 'H', 8, 3, 'x'); // Restoration Druid
  await addChar('a1', 'D', 7, 2, 0); // Destruction Warlock, off Affliction
  await addChar('a2', 'H', 4, 1, 2); // Holy Priest, off Shadow
  await addChar('a3', 'D', 6, 2, 'x'); // Frost Mage
  const rec = db.get('m/u1');
  assert.equal(rec.alts.length, 4);
  for (const c of ['Druid', 'Warlock', 'Priest', 'Mage']) assert.ok(calls.includes(`PUT /guilds/g1/members/u1/roles/c-${c}`), c);
  assert.ok(!calls.includes('PUT /guilds/g1/members/u1/roles/r-heal'), 'alt nem ad szerep-rangot');

  const home = calls.lastEdit;
  const addBtn = home.components[0].components[1];
  assert.equal(addBtn.disabled, true, '4 alt után a hozzáadás tiltott');
  assert.equal(home.components[1].components[0].options.length, 4);

  const alt = altRoster();
  assert.match(alt.title, /4 alt, 1 tagtól/);
  assert.match(alt.description, /Healer \(2\)/);
  assert.match(alt.description, /Plausz.*Frost Mage/);
  assert.match(mainRoster(), /\+4 alt/);

  // Ötödik alt elutasítva (nincs a4 hely)
  const r5 = await send(click('v:a4:D:3:0:x|'));
  assert.match(r5.data.embeds[0].title, /Hiba/);
  await drain();
  assert.equal(db.get('m/u1').alts.length, 4);
  assert.equal(db.get('m/u1').alts[3].cls, 6, 'a 4. alt érintetlen');

  // Alt kiválasztása a menüből, majd törlés
  let r = await send(click('menu:alt', ['1']));
  assert.equal(r.type, 6);
  await drain();
  assert.match(calls.lastEdit.embeds[0].description, /Destruction Warlock/);
  await send(click('menu:delalt:1'));
  await drain();
  const after = db.get('m/u1').alts.map((a) => a.cls);
  assert.deepEqual(after, [8, 4, 6]);
});

test('régi (egy altos) rekord átalakul', async () => {
  db.set('m/u2', { userId: 'u2', main: { role: 'D', cls: 3, spec: 0, off: null, name: null }, alt: { role: 'T', cls: 1, spec: 1, off: null, name: 'Tanki' } });
  const r = await send(click('menu:home', undefined, false));
  assert.deepEqual(r, { type: 5, data: { flags: 64 } });
  await drain();
  // a menü a saját (u1) adatait mutatja, a roster viszont u2 altját is
  const { publishRoster } = await import('../lib/roster.js');
  await publishRoster();
  assert.match(altRoster().description, /zulu.*Protection Paladin – \*\*Tanki\*\*/);
});

test('érvénytelen kombináció elutasítva (Priest tank, rossz slot)', async () => {
  let r = await send(click('v:m:T:4:0:x|'));
  assert.match(r.data.embeds[0].title, /Hiba/);
  r = await send(click('w:a7:start'));
  assert.match(r.data.embeds[0].title, /Hiba/);
});

test('adatok törlése leveszi a kezelt rangokat', async () => {
  calls.length = 0;
  member.roles = ['panda', 'r-tank', 'r-dps', 'c-Warrior', 'c-Druid'];
  await send(click('menu:delall2'));
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
