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
    getGuild: async () => db.get('guild') ?? null,
    saveGuild: async (g) => db.set('guild', g),
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
const emojis = [];
const blizzard = { roster: null, profiles: {}, calls: [] };
globalThis.fetch = async (url, init = {}) => {
  if (url.startsWith('https://oauth.battle.net/')) return Response.json({ access_token: 'bz', expires_in: 86399 });
  if (url.startsWith('https://eu.api.blizzard.com/')) {
    const u = new URL(url);
    blizzard.calls.push(u.pathname + '?' + u.searchParams.get('namespace'));
    if (u.pathname.endsWith('/roster')) return blizzard.roster && u.pathname.includes(encodeURIComponent('pändemonium')) ? Response.json(blizzard.roster) : new Response('', { status: 404 });
    const slug = decodeURIComponent(u.pathname.split('/').pop());
    return blizzard.profiles[slug] ? Response.json(blizzard.profiles[slug]) : new Response('', { status: 404 });
  }
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
  if (path === '/applications/app/emojis' && init.method === 'GET') return Response.json({ items: emojis });
  if (path === '/applications/app/emojis' && init.method === 'POST') { const e = { id: `e${emojis.length + 1}`, name: body.name }; emojis.push(e); return Response.json(e); }
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

test('armory-link csak teljes (Név Vezetéknév) névhez', async () => {
  const { armoryUrl, describeChar } = await import('../lib/data.js');
  assert.equal(armoryUrl('Plausz Pandemonium'), 'https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/character/plausz-pandemonium');
  assert.equal(armoryUrl('  Árvíz   Tűrő '), 'https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/character/%C3%A1rv%C3%ADz-t%C5%B1r%C5%91');
  assert.equal(armoryUrl('Plausz'), null);
  assert.equal(armoryUrl(null), null);
  const ch = { role: 'D', cls: 7, spec: 0, off: null, name: 'Plausz Pandemonium' };
  assert.match(describeChar(ch, { link: true }), /\[\*\*Plausz Pandemonium\*\*\]\(https:\/\/worldofwarcraft\.blizzard\.com\/en-gb\/forever\/eu\/armory\/character\/plausz-pandemonium\)/);
  assert.doesNotMatch(describeChar(ch), /armory/);
});

test('class-eloszlás: mind a 9 class, arány, hiányzók, altok, színes ikon', async () => {
  const { classDistribution } = await import('../lib/roster.js');
  const { setClassIcons } = await import('../lib/data.js');
  setClassIcons({});
  const D = (cls) => ({ role: 'D', cls, spec: 0, off: null, name: null });
  const e = classDistribution([D(7), D(7), D(7), D(4)], [D(8)]);
  assert.match(e.title, /4 fő/);
  assert.match(e.description, /🟪 `██████████  3  75%` \*\*Warlock\*\*/);
  assert.match(e.description, /⬜ `███░░░░░░░  1  25%` \*\*Priest\*\*/);
  assert.match(e.description, /🟧 `░{10}  0   0%` \*\*Druid\*\* · _\+1 alt_/);
  assert.match(e.description, /Nincs még main:\*\* Warrior, Paladin, Hunter, Rogue, Shaman, Mage, Druid/);
  setClassIcons({ Warlock: '<:pd_warlock:1>' });
  assert.match(classDistribution([D(7)], []).description, /<:pd_warlock:1> `/);
  setClassIcons({});
});

test('roster: class-eloszlás a fő üzenetben, név modal teljes névvel', async () => {
  const { buildRoster } = await import('../lib/roster.js');
  const [main] = await buildRoster();
  assert.equal(main.embeds.length, 3);
  assert.match(main.embeds[1].title, /Class-eloszlás/);
  const [, alt] = await buildRoster();
  const link = alt.components[0].components.find((c) => c.style === 5);
  assert.equal(link.url, 'https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/guild/p%C3%A4ndemonium');
  const { nameModal } = await import('../lib/wizard.js');
  const m = nameModal('m:D:7:0:x', 'm', 'Plausz Pandemonium');
  assert.equal(m.components[0].components[0].max_length, 32);
  assert.equal(m.components[0].components[0].value, 'Plausz Pandemonium');
});

test('class-emojik: a hiányzók feltöltődnek, a roster a bot emojijait használja', async () => {
  const cfg = db.get('cfg');
  delete cfg.classEmojis;
  const { publishRoster } = await import('../lib/roster.js');
  await publishRoster();
  assert.equal(emojis.length, 9);
  assert.equal(emojis[0].name, 'pd_warrior');
  assert.equal(db.get('cfg').classEmojis.Warlock, '<:pd_warlock:e8>');
  await publishRoster(); // másodszor nem tölt fel újra
  assert.equal(emojis.length, 9);
  const { circlePng } = await import('../lib/png.js');
  const png = circlePng('8788EE');
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
});

test('Blizzard guild-szinkron: kulcs nélkül kikapcsolva, kulccsal guild blokk és ilvl a rosterben', async () => {
  const { GET } = await import('../api/cron.js');
  const auth = { headers: { authorization: 'Bearer cron' } };
  let r = await (await GET(new Request('https://x/api/cron', auth))).json();
  assert.equal(r.guild, 'kikapcsolva');
  assert.equal(blizzard.calls.length, 0);

  process.env.BLIZZARD_CLIENT_ID = 'id';
  process.env.BLIZZARD_CLIENT_SECRET = 'secret';
  blizzard.roster = { members: [
    { character: { name: 'Plausz', surname: 'Pandemonium', slug: 'plausz-pandemonium', level: 20, playable_class: { id: 9 } }, rank: 0 },
    { character: { name: 'Patkány', surname: 'Frici', slug: 'patkány-frici', level: 15, playable_class: { id: 4 } }, rank: 3 },
    { character: { name: 'Kicsi', surname: 'Mag', slug: 'kicsi-mag', level: 5, playable_class: { id: 8 } }, rank: 4 },
  ] };
  blizzard.profiles['plausz-pandemonium'] = { level: 21, equipped_item_level: 34, character_class: { id: 9 } };
  db.set('m/u1', { userId: 'u1', main: { role: 'D', cls: 7, spec: 0, off: null, name: 'Plausz Pandemonium' }, alts: [] });
  r = await (await GET(new Request('https://x/api/cron', auth))).json();
  assert.equal(r.guild, '3 karakter, ebből 1 item levellel, 2 legalább 10. szintű');
  assert.ok(blizzard.calls.every((c) => c.endsWith('?profile-forever-eu')));
  assert.ok(!blizzard.calls.some((c) => c.includes('kicsi-mag')), '10. szint alatt nincs profil-lekérés');
  const g = db.get('guild');
  assert.equal(g.members[0].ilvl, 34);
  assert.equal(g.members[0].level, 21);
  assert.equal(g.members[1].cls, 3);
  assert.match(mainRoster(), /Plausz Pandemonium\*\*\]\(.*\) · 21\. szint · ilvl 34/);
  const ge = messages[db.get('cfg').altMessageId].embeds[1];
  assert.match(ge.title, /3 karakter/);
  assert.match(ge.description, /Nincs a rosterben \(2\):.*Patkány Frici \(15\).*Kicsi Mag \(5\)/);
  assert.doesNotMatch(ge.description, /Plausz Pandemonium/);
  delete process.env.BLIZZARD_CLIENT_ID;
  delete process.env.BLIZZARD_CLIENT_SECRET;
});

test('guild-párosítás: pontos, ékezet nélküli, egyértelmű keresztnév; ütközésnél nincs párosítás', async () => {
  const { makeGuildMatcher } = await import('../lib/roster.js');
  const G = (name) => ({ name, slug: name.toLocaleLowerCase('hu').replace(' ', '-') });
  const guild = [G('Professor Sawier'), G('Power Zul'), G('Power Archdruid'), G('Patkány Frici'), G('Ash Zulunga'), G('Lazy Healz')];
  const match = makeGuildMatcher(guild, ['Professor Sawier', 'Power', 'Patkany Frici', 'Ash', 'Lazy', 'lazy']);
  assert.equal(match('Professor Sawier').slug, 'professor-sawier');
  assert.equal(match('Patkany Frici').slug, 'patkány-frici', 'ékezet nélkül is');
  assert.equal(match('Ash').slug, 'ash-zulunga', 'egyértelmű keresztnév');
  assert.equal(match('Power'), null, 'két Power a guildben');
  assert.equal(match('Lazy'), null, 'két rosterbeli karakter is Lazy-re hivatkozik');
  assert.equal(match('Ismeretlen'), null);
  assert.equal(match(null), null);
});
