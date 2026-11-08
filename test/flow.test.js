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
    getApplication: async (id) => structuredClone(db.get(`tgf/${id}`) ?? null),
    saveApplication: async (r) => db.set(`tgf/${r.userId}`, structuredClone(r)),
    deleteApplication: async (id) => db.delete(`tgf/${id}`),
  },
});

const ROLES = [
  ['r-tank', '🛡️ Tank'], ['r-heal', '💚 Healer'], ['r-dps', '🗡️ DPS'],
  ...['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'].map((n) => [`c-${n}`, n]),
  ['panda', 'Panda'], ['friends', 'Friends'], ['officer', 'Officer'],
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
  if (path.startsWith('/channels/roster/messages/') && init.method === 'DELETE') { delete messages[path.split('/').pop()]; return new Response(null, { status: 204 }); }
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

test('guild-párosítás: név, class, Discord-név; ütközésnél nincs párosítás', async () => {
  const { matchGuildChars } = await import('../lib/roster.js');
  const G = (name, cls) => ({ name, cls, slug: name.toLocaleLowerCase('hu').replace(' ', '-') });
  const guild = [G('Professor Sawier', 1), G('Power Zul', 0), G('Power Archdruid', 8), G('Patkány Frici', 3), G('Ash Zulunga', 1), G('Lazy Healz', 4), G('Onkel Rizzo', 4), G('Csont Sovány', 7)];
  const C = (key, name, cls, dn) => ({ key, name, cls, dn });
  const res = matchGuildChars(guild, [
    C('a', 'Professor Sawier', 1, 'Sawier'), // pontos
    C('b', 'Patkany Frici', 3, 'x'), // ékezet nélkül
    C('c', 'Power', 8, 'Powerful'), // két Power, a class dönt → Archdruid
    C('d', null, 1, 'zulunga'), // név nélkül, Discord-név + class → Ash Zulunga (auto)
    C('e', null, 4, 'Rizzo'), // Discord-név + class → Onkel Rizzo (auto)
    C('f', null, 7, 'Lazy'), // Discord-név Lazy, de Warlock → Lazy Healz Priest: nincs
    C('g', null, 4, 'Sawier'), // a Professor Sawier-t már név alapján lefoglalták, és class sem stimmel: nincs
    C('h', 'Power', 2, 'x'), // Power, de egyik class sem stimmel: nincs
  ]);
  const got = (k) => res.get(k) && `${res.get(k).m.slug}${res.get(k).auto ? ' (auto)' : ''}`;
  assert.equal(got('a'), 'professor-sawier');
  assert.equal(got('b'), 'patkány-frici');
  assert.equal(got('c'), 'power-archdruid');
  assert.equal(got('d'), 'ash-zulunga (auto)');
  assert.equal(got('e'), 'onkel-rizzo (auto)');
  assert.equal(got('f'), undefined);
  assert.equal(got('g'), undefined);
  assert.equal(got('h'), undefined);
  // két név nélküli rosterkarakter ugyanarra esne → egyik sem
  const dup = matchGuildChars(guild, [C('x', null, 4, 'Rizzo'), C('y', null, 4, 'Onkel')]);
  assert.equal(dup.size, 0);
});

test('officer mód: más tag szerkesztése /roster-admin paranccsal, jogosultság-ellenőrzés', async () => {
  const officer = { user: { id: 'u1', username: 'plausz' }, nick: 'Plausz', roles: ['panda'], permissions: String(1 << 28) };
  const pleb = { user: { id: 'u3', username: 'haver' }, roles: ['friends'], permissions: '0' };
  const TARGET = '123456789012345678';
  const extra = { [TARGET]: { user: { id: TARGET, username: 'uj' }, nick: 'Újonc', roles: ['panda'] } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('https://discord.com/api/v10', '');
    if (init.method === 'GET' && path === `/guilds/g1/members/${TARGET}`) { calls.push(`GET ${path}`); return Response.json(extra[TARGET]); }
    return prevFetch(url, init);
  };
  const as = (m, payload) => signed({ guild_id: 'g1', token: 'tok', member: m, ...payload });
  // jobb klikkes menü (USER context menu): ugyanaz a menü
  let r = await send(as(officer, { type: 2, data: { name: 'Roster szerkesztése', type: 2, target_id: TARGET, resolved: { users: { [TARGET]: extra[TARGET].user } } } }));
  assert.deepEqual(r, { type: 5, data: { flags: 64 } });
  await drain();
  assert.match(calls.lastEdit.embeds[0].title, /Újonc karakterei/);
  assert.equal(calls.lastEdit.components[0].components[0].custom_id, `t${TARGET}.w:m:start`);
  // jog nélkül elutasítva
  r = await send(as(pleb, { type: 2, data: { name: 'roster-admin', options: [{ name: 'tag', type: 6, value: TARGET }] } }));
  assert.match(r.data.content, /Officer jog/);
  // officer: a cél-tag menüje, jelölt gombokkal
  r = await send(as(officer, { type: 2, data: { name: 'roster-admin', options: [{ name: 'tag', type: 6, value: TARGET }] } }));
  assert.deepEqual(r, { type: 5, data: { flags: 64 } });
  await drain();
  assert.match(calls.lastEdit.embeds[0].title, /Újonc karakterei/);
  const startBtn = calls.lastEdit.components[0].components[0].custom_id;
  assert.equal(startBtn, `t${TARGET}.w:m:start`);
  // jelölt gomb jog nélkül: elutasítva
  r = await send(as(pleb, { type: 3, data: { custom_id: startBtn }, message: { flags: 64 } }));
  assert.match(r.data.content, /Officer jog/);
  // végig a varázslón officerként, mentés a cél-tag nevére
  const c = (id, values) => send(as(officer, { type: 3, data: { custom_id: `t${TARGET}.${id}`, values }, message: { flags: 64 } }));
  r = await c('w:m:start');
  assert.match(r.data.components[0].components[0].custom_id, new RegExp(`^t${TARGET}\\.w:m:r`));
  r = await c('w:m:r', ['H']);
  r = await c('w:m:c:H', ['4']);
  r = await c('w:m:p:H:4', ['1']);
  r = await c('w:m:o:H:4:1', ['x']);
  await drain();
  const nameBtn = calls.lastEdit.components[0].components[0].custom_id;
  assert.equal(nameBtn, `t${TARGET}.n:m:H:4:1:x|`);
  r = await send(as(officer, { type: 3, data: { custom_id: nameBtn }, message: { flags: 64 } }));
  assert.equal(r.type, 9);
  assert.equal(r.data.custom_id, `t${TARGET}.m:m:H:4:1:x`);
  assert.equal(r.data.components[0].components[0].custom_id, 'name');
  calls.length = 0;
  r = await send(as(officer, { type: 5, data: { custom_id: `t${TARGET}.m:m:H:4:1:x`, components: [{ type: 1, components: [{ type: 4, custom_id: 'name', value: 'Onkel Rizzo' }] }] }, message: { flags: 64 } }));
  await drain();
  assert.deepEqual(db.get(`m/${TARGET}`).main, { role: 'H', cls: 4, spec: 1, off: null, name: 'Onkel Rizzo' });
  assert.equal(db.get('m/u1')?.main?.name ?? null, db.get('m/u1')?.main?.name ?? null, 'az officer saját adata nem változik');
  assert.ok(calls.includes(`PUT /guilds/g1/members/${TARGET}/roles/r-heal`), 'a cél-tag kapja a rangot');
  assert.ok(!calls.some((c2) => c2.includes('/members/u1/roles/')), 'az officer rangjai nem változnak');
  assert.match(calls.lastEdit.embeds[0].title, /Újonc karakterei/);
  globalThis.fetch = prevFetch;
});

test('🔄 gomb: Blizzard-szinkron is fut, de legfeljebb 10 percenként', async () => {
  process.env.BLIZZARD_CLIENT_ID = 'id';
  process.env.BLIZZARD_CLIENT_SECRET = 'secret';
  db.set('guild', { syncedAt: new Date(Date.now() - 11 * 60_000).toISOString(), members: [] });
  blizzard.calls.length = 0;
  await send(click('refresh', undefined, false));
  await drain();
  assert.ok(blizzard.calls.some((c) => c.includes('/roster')), 'régi adatnál szinkronizál');
  blizzard.calls.length = 0;
  await send(click('refresh', undefined, false));
  await drain();
  assert.equal(blizzard.calls.length, 0, 'friss adatnál nem hívja újra a Blizzardot');
  delete process.env.BLIZZARD_CLIENT_ID;
  delete process.env.BLIZZARD_CLIENT_SECRET;
});

test('officer párosítás: lista → karakter → tag → main neve / új alt / DM, jogosultság', async () => {
  const officer = { user: { id: 'u1', username: 'plausz' }, nick: 'Plausz', roles: ['panda'], permissions: String(1 << 28) };
  const pleb = { user: { id: 'u3', username: 'haver' }, roles: ['friends'], permissions: '0' };
  const prevFetch = globalThis.fetch;
  const dms = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('https://discord.com/api/v10', '');
    if (init.method === 'GET' && path === '/guilds/g1/members/u2') return Response.json(MEMBERS[1]);
    if (path === '/users/@me/channels') return Response.json({ id: `dm-${JSON.parse(init.body).recipient_id}` });
    if (path.startsWith('/channels/dm-')) { dms.push({ path, body: JSON.parse(init.body) }); return Response.json({ id: 'x' }); }
    return prevFetch(url, init);
  };
  db.set('guild', { syncedAt: new Date().toISOString(), members: [
    { name: 'Zulu Rogue', slug: 'zulu-rogue', level: 20, cls: 3, ilvl: 30 },
    { name: 'Zulu Paladin', slug: 'zulu-paladin', level: 18, cls: 1, ilvl: 25 },
  ] });
  db.set('m/u2', { userId: 'u2', main: { role: 'D', cls: 3, spec: 0, off: null, name: null }, alts: [] });
  const as = (m, payload) => signed({ guild_id: 'g1', token: 'tok', member: m, ...payload });
  const g = async (custom_id, values) => { const r = await send(as(officer, { type: 3, data: { custom_id, values }, message: { flags: 64 } })); await drain(); return r; };

  let r = await send(as(pleb, { type: 2, data: { name: 'parositas' } }));
  assert.match(r.data.content, /Officer jog/);
  r = await send(as(pleb, { type: 3, data: { custom_id: 'g:list:0' }, message: { flags: 64 } }));
  assert.match(r.data.content, /Officer jog/);

  r = await send(as(officer, { type: 2, data: { name: 'parositas' } }));
  assert.deepEqual(r, { type: 5, data: { flags: 64 } });
  await drain();
  // a név nélküli Rogue main Discord-neve „zulu”, de két Zulu van a guildben → csak a class dönt: Zulu Rogue automatikusan párosul
  let opts = calls.lastEdit.components[0].components[0].options.map((o) => o.value);
  assert.deepEqual(opts, ['zulu-paladin']);

  r = await g('g:pick', ['zulu-paladin']);
  assert.equal(r.type, 6);
  assert.equal(calls.lastEdit.components[0].components[0].type, 5, 'Discord-tag választó');
  await g('g:who:zulu-paladin', ['u2']);
  const btns = calls.lastEdit.components.flatMap((rw) => rw.components);
  const mainBtn = btns.find((b) => b.custom_id === 'g:set:zulu-paladin:u2:m');
  assert.ok(mainBtn.disabled, 'Rogue main nem kaphat Paladin nevet');
  const newAlt = btns.find((b) => b.custom_id === 'g:new:zulu-paladin:u2:a');
  assert.ok(newAlt && !newAlt.disabled);

  await g('g:new:zulu-paladin:u2:a');
  assert.deepEqual(calls.lastEdit.components[0].components[0].options.map((o) => o.label), ['Holy', 'Protection', 'Retribution']);
  calls.length = 0;
  await g('g:spec:zulu-paladin:u2:a', ['1']);
  assert.deepEqual(db.get('m/u2').alts, [{ role: 'T', cls: 1, spec: 1, off: null, name: 'Zulu Paladin' }]);
  assert.ok(calls.includes('PUT /guilds/g1/members/u2/roles/c-Paladin'), 'class-rang a tagnak');
  assert.match(calls.lastEdit.embeds[0].description, /Zulu Paladin\*\* felvéve zulu altjaként/);
  assert.match(calls.lastEdit.embeds[0].description, /\*\*0\*\* guildkarakter nincs még a rosterben/);

  // meglévő main nevének beállítása azonos classnál
  db.get('guild').members.push({ name: 'Rogue Masik', slug: 'rogue-masik', level: 12, cls: 3, ilvl: 15 });
  db.set('m/u2', { userId: 'u2', main: { role: 'D', cls: 3, spec: 0, off: null, name: 'Valami Mas' }, alts: [] });
  await g('g:set:rogue-masik:u2:m');
  assert.equal(db.get('m/u2').main.name, 'Rogue Masik');

  // névkereső: gomb → modal → szűrt lista; parancs opcióval közvetlenül
  db.get('guild').members.push({ name: 'Árvíz Tűrő', slug: 'árvíz-tűrő', level: 11, cls: 7, ilvl: 12 });
  r = await send(as(officer, { type: 3, data: { custom_id: 'g:search' }, message: { flags: 64 } }));
  assert.equal(r.type, 9);
  assert.equal(r.data.custom_id, 'g:q');
  await send(as(officer, { type: 5, data: { custom_id: 'g:q', components: [{ type: 1, components: [{ type: 4, custom_id: 'query', value: 'arviz' }] }] }, message: { flags: 64 } }));
  await drain();
  assert.deepEqual(calls.lastEdit.components[0].components[0].options.map((o) => o.value), ['árvíz-tűrő']);
  assert.match(calls.lastEdit.embeds[0].description, /Keresés: \*\*arviz\*\* — 1 találat/);
  assert.ok(calls.lastEdit.components[1].components.some((b) => b.custom_id === 'g:search:arviz'), 'új keresés az előző szöveggel');
  r = await send(as(officer, { type: 2, data: { name: 'parositas', options: [{ name: 'nev', type: 3, value: 'nincsilyen' }] } }));
  await drain();
  assert.match(calls.lastEdit.embeds[0].description, /0 találat/);
  r = await send(as(pleb, { type: 5, data: { custom_id: 'g:q', components: [] }, message: { flags: 64 } }));
  assert.match(r.data.content, /Officer jog/);

  // DM-felkérés
  await g('g:dm:u2:zulu-rogue');
  assert.equal(dms.length, 1);
  assert.match(dms[0].body.content, /<#roster>.*Zulu Rogue/s);
  assert.match(calls.lastEdit.embeds[0].description, /Üzenetet küldtem/);
  globalThis.fetch = prevFetch;
});

test('tagfelvétel: panel, felugró ablak, privát csatorna, ismételt beküldés, lezárás', async () => {
  Object.assign(process.env, { TGF_CHANNEL_ID: 'tgfch', TGF_LOG_CHANNEL_ID: 'tgflog' });
  const tgf = { posts: [], created: [], deleted: [], channels: new Set(), panel: null, applicantRoles: [] };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('https://discord.com/api/v10', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const m = init.method;
    if (path === '/channels/tgfch/messages' && m === 'POST') { tgf.panel = body; return Response.json({ id: 'panel1' }); }
    if (path === '/channels/tgfch/messages/panel1' && m === 'PATCH') { tgf.panel = body; return Response.json({}); }
    if (path === '/channels/tgfch' && m === 'GET') return Response.json({ id: 'tgfch', parent_id: 'cat' });
    if (path === '/guilds/g1/channels' && m === 'POST') { const id = `ch${tgf.created.length + 1}`; tgf.created.push(body); tgf.channels.add(id); return Response.json({ id }); }
    const cm = path.match(/^\/channels\/(\w+)(\/messages)?$/);
    if (cm && cm[2] && m === 'POST') { tgf.posts.push({ ch: cm[1], body }); return Response.json({ id: 'x' }); }
    if (cm && !cm[2] && m === 'GET') return tgf.channels.has(cm[1]) ? Response.json({ id: cm[1] }) : new Response('{}', { status: 404 });
    if (cm && !cm[2] && m === 'DELETE') { tgf.deleted.push(cm[1]); tgf.channels.delete(cm[1]); return Response.json({}); }
    if (path === '/guilds/g1/members/900000000000000001' && m === 'GET') return Response.json({ user: { id: '900000000000000001' }, roles: tgf.applicantRoles });
    return prevFetch(url, init);
  };
  try {
    const { publishTgfPanel } = await import('../lib/tgf.js');
    // panel kitétele, majd ugyanannak az üzenetnek a frissítése
    let rep = await publishTgfPanel();
    assert.equal(rep.messageId, 'panel1');
    assert.deepEqual(rep.missingRoles, ['Klánvezető', 'OldPanda']);
    assert.match(tgf.panel.embeds[0].description, /Elbírálás/);
    assert.equal(tgf.panel.components[0].components[0].custom_id, 'tgf:apply');
    rep = await publishTgfPanel();
    assert.equal(rep.messageId, 'panel1');

    const applicant = { user: { id: '900000000000000001', username: 'ujonc' }, nick: 'Új Jelentkező', roles: [], permissions: '0' };
    const officer = { user: { id: 'u1', username: 'plausz' }, nick: 'Plausz', roles: ['panda', 'officer'], permissions: String(1 << 28) };
    const as = (mem, payload) => signed({ guild_id: 'g1', token: 'tok', channel_id: 'ch1', member: mem, ...payload });
    // gomb → felugró ablak 5 mezővel
    let r = await send(as(applicant, { type: 3, data: { custom_id: 'tgf:apply' }, message: { flags: 0 } }));
    assert.equal(r.type, 9);
    assert.equal(r.data.custom_id, 'tgf:submit');
    assert.equal(r.data.components.length, 5);
    // beküldés → halasztott ephemeral válasz, privát csatorna
    assert.ok(r.data.components.every((row) => row.components[0].required), 'minden mező kötelező');
    const values = { nick: 'Zugi', char: 'Zug Zug', cls: 'Shaman resto', play: 'raid, BG', intro: 'Régi Taurisként jönnék, Plausz hívott.' };
    const modal = (v) => as(applicant, { type: 5, data: { custom_id: 'tgf:submit', components: Object.entries(v).map(([k, value]) => ({ type: 1, components: [{ type: 4, custom_id: k, value }] })) } });
    r = await send(modal(values));
    assert.deepEqual(r, { type: 5, data: { flags: 64 } });
    await drain();
    assert.equal(tgf.created.length, 1);
    const ch = tgf.created[0];
    assert.equal(ch.name, 'tgf-zug-zug');
    assert.equal(ch.parent_id, 'cat');
    const ow = Object.fromEntries(ch.permission_overwrites.map((o) => [o.id, o]));
    assert.equal(ow.g1.deny, String(1n << 10n), '@everyone nem látja');
    assert.ok(BigInt(ow['900000000000000001'].allow) & (1n << 10n), 'a jelentkező látja');
    assert.ok(BigInt(ow.app.allow) & (1n << 10n), 'a bot látja');
    assert.ok(ow.panda && ow.officer, 'Panda és Officer látja');
    assert.equal(ow.friends, undefined, 'Friends nem');
    const post = tgf.posts.find((p) => p.ch === 'ch1').body;
    assert.match(post.content, /<@900000000000000001> <@&officer>/);
    assert.equal(post.embeds[0].title, 'Jelentkezés: Zugi');
    assert.equal(post.embeds[0].fields[2].value, 'Shaman resto');
    assert.equal(post.components[0].components[0].custom_id, 'tgf:close:900000000000000001');
    assert.match(calls.lastEdit.content, /<#ch1>/);
    assert.equal(db.get('tgf/900000000000000001').channelId, 'ch1');
    // ismételt beküldés: nincs új csatorna, a meglévőbe kerül
    await send(modal({ ...values, play: 'csak PvP' }));
    await drain();
    assert.equal(tgf.created.length, 1);
    assert.match(calls.lastEdit.content, /Már van nyitott jelentkezésed: <#ch1>/);
    assert.match(tgf.posts.at(-1).body.embeds[0].title, /Frissített/);
    // lezárás: jelentkező nem zárhatja le, Officer megerősítés után igen
    r = await send(as(applicant, { type: 3, data: { custom_id: 'tgf:close:900000000000000001' }, message: { flags: 0 } }));
    assert.match(r.data.content, /csak Officer/);
    r = await send(as(officer, { type: 3, data: { custom_id: 'tgf:close:900000000000000001' }, message: { flags: 0 } }));
    assert.deepEqual(r.data.components[0].components.map((b) => b.custom_id), ['tgf:close2:900000000000000001:ok', 'tgf:close2:900000000000000001:no']);
    // „Felvettük” klánrang nélkül: nem zár le, figyelmeztet
    r = await send(as(officer, { type: 3, data: { custom_id: 'tgf:close2:900000000000000001:ok' }, message: { flags: 64 } }));
    assert.equal(r.type, 6);
    await drain();
    assert.deepEqual(tgf.deleted, []);
    assert.match(calls.lastEdit.content, /még nincs klánrangja/);
    // rang megadva → lezárás, napló a döntéssel és a ranggal
    tgf.applicantRoles = ['panda'];
    await send(as(officer, { type: 3, data: { custom_id: 'tgf:close2:900000000000000001:ok' }, message: { flags: 64 } }));
    await drain();
    assert.deepEqual(tgf.deleted, ['ch1']);
    assert.equal(db.get('tgf/900000000000000001'), undefined);
    const log = tgf.posts.find((p) => p.ch === 'tgflog').body;
    assert.match(log.embeds[0].title, /Felvéve: Zugi/);
    assert.equal(log.embeds[0].fields[3].value, 'csak PvP');
    assert.equal(log.embeds[0].fields[4].value, 'Panda');
  } finally {
    globalThis.fetch = prevFetch;
    delete process.env.TGF_CHANNEL_ID;
    delete process.env.TGF_LOG_CHANNEL_ID;
  }
});

test('nagy roster: több üzenetre bomlik, sorhatáron, csonka emoji nélkül; a gombok az utolsón', async () => {
  const { publishRoster } = await import('../lib/roster.js');
  const before = MEMBERS.length;
  for (let n = 0; n < 40; n++) {
    const id = `big${n}`;
    MEMBERS.push({ user: { id, username: `hosszunevu_tag_${n}` }, roles: ['panda'] });
    db.set(`m/${id}`, { userId: id, main: { role: 'D', cls: n % 9 === 8 ? 8 : 7, spec: 0, off: null, name: `Hosszúnevű${n} Karakterneve` }, alts: [{ role: 'D', cls: 6, spec: 0, off: null, name: `Altocska${n} Masodiknev` }] });
  }
  db.get('cfg').classEmojis = Object.fromEntries(['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'].map((c, i) => [c, `<:pd_${c.toLowerCase()}:15686434554107${i}69>`]));
  const r = await publishRoster();
  assert.ok(r.messages > 2, `több üzenet kell (${r.messages})`);
  const ids = db.get('cfg').rosterMessageIds;
  assert.equal(ids.length, r.messages);
  ids.forEach((id, k) => {
    const m = messages[id];
    const total = m.embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0), 0);
    assert.ok(total <= 6000, `üzenet ${k}: ${total}`);
    for (const e of m.embeds) {
      assert.ok((e.description ?? '').length <= 4096);
      assert.doesNotMatch(e.description ?? '', /rövidítve/);
      assert.doesNotMatch(e.description ?? '', /<:[^>\n]*(\n|$)/, 'nincs félbevágott emoji');
    }
    assert.equal(m.components.length, k === ids.length - 1 ? 1 : 0, 'gombok csak az utolsón');
  });
  assert.match(messages[ids[0]].embeds[0].title, /Panda roster — 4\d kitöltött/);
  assert.ok(Object.values(messages).some((m) => m.embeds?.some((e) => /folytatás/.test(e.title))), 'folytatás embed');
  // kevesebb tag → kevesebb üzenet: a régiek törlődnek, újrakitétel
  MEMBERS.splice(before);
  for (let n = 0; n < 40; n++) db.delete(`m/big${n}`);
  calls.length = 0;
  const r2 = await publishRoster();
  assert.ok(r2.messages < r.messages);
  assert.equal(calls.filter((c) => c.startsWith('DELETE /channels/roster/messages/')).length, r.messages);
  // azonos számnál helyben szerkeszt
  calls.length = 0;
  await publishRoster();
  assert.ok(!calls.some((c) => c.startsWith('POST /channels/roster/messages')), 'nincs újrakitétel');
});
