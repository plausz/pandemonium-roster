import { waitUntil } from '@vercel/functions';
import { verifySignature, editOriginal, GUILD_ID, dc, displayName } from '../lib/discord.js';
import { specsFor } from '../lib/data.js';
import { getMember, saveMember, deleteMember } from '../lib/store.js';
import { syncRoles } from '../lib/roles.js';
import { publishRoster } from '../lib/roster.js';
import { syncGuild } from '../lib/sync.js';
import * as W from '../lib/wizard.js';
import { handlePairing, searchModal, cleanQuery } from '../lib/pairing.js';
import { applyModal, submitApplication, closeConfirm, closeApplication, memberClanRanks, FIELDS as TGF_FIELDS } from '../lib/tgf.js';

const T = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL: 5 };
const R = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE: 7, MODAL: 9 };
const json = (data) => Response.json(data);
// Meglévő üzenet frissítésekor a flags mezőt nem küldjük újra (az ephemeral jelző nem módosítható).
const strip = ({ flags, ...rest }) => rest;

// --- Admin (officer) mód ---
// Officerként a /roster-admin paranccsal vagy a tagon jobb klikk → Alkalmazások → „Roster szerkesztése”
// menüponttal más tag adatai is szerkeszthetők. Ilyenkor minden gomb custom_id-je „t<célTagId>.” előtagot kap,
// és minden kattintásnál újra ellenőrizzük, hogy a kattintó officer-e (Rangok kezelése vagy Adminisztrátor jog).
const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;
export const isOfficer = (i) => (BigInt(i.member?.permissions ?? '0') & (MANAGE_ROLES | ADMINISTRATOR)) !== 0n;
const TARGET_RE = /^t(\d{15,22})\./;
function tagIds(payload, target) {
  if (!target || !payload) return payload;
  const pre = (id) => `t${target}.${id}`;
  // A modal szövegmezőjét (type 4) nem jelöljük, azt név szerint olvassuk ki.
  const walk = (comps) => comps?.map((c) => ({
    ...c,
    ...(c.custom_id && c.type !== 4 ? { custom_id: pre(c.custom_id) } : {}),
    ...(c.components ? { components: walk(c.components) } : {}),
  }));
  return { ...payload, ...(payload.components ? { components: walk(payload.components) } : {}), ...(payload.custom_id ? { custom_id: pre(payload.custom_id) } : {}) };
}

// Egy interakció környezete: kinek az adatain dolgozunk, és a válaszok ennek megfelelően jelölve mennek ki.
function context(i, rawId = i.data?.custom_id ?? '') {
  const m = rawId.match(TARGET_RE);
  const target = m ? m[1] : null;
  const ctx = {
    i,
    id: m ? rawId.slice(m[0].length) : rawId,
    target,
    userId: target ?? i.member.user.id,
    denied: !!target && !isOfficer(i),
    tag: (payload) => tagIds(payload, target),
  };
  ctx.reply = (data) => json({ type: R.MESSAGE, data: ctx.tag(data) });
  ctx.update = (data) => json({ type: R.UPDATE, data: strip(ctx.tag(data)) });
  ctx.edit = (payload) => editOriginal(i.token, ctx.tag(payload));
  return ctx;
}
const reply = (data) => json({ type: R.MESSAGE, data });
const update = (data) => json({ type: R.UPDATE, data: strip(data) });

// A cél-tag adatai admin módban (név a fejléchez, rangok a rangkiosztáshoz).
async function targetMember(ctx) {
  if (!ctx.target) return null;
  return dc('GET', `/guilds/${GUILD_ID()}/members/${ctx.target}`);
}

// A Discord 3 másodpercen belül választ vár. Ami tárolt adatot olvas, azt azonnal „elhalasztott” válasszal
// nyugtázzuk, és a tényleges tartalmat utólag írjuk be – így hidegindításnál sem akad el a felület.
function deferred(ctx, { ephemeralNew = false } = {}, work) {
  const { i } = ctx;
  const started = Date.now();
  waitUntil(
    work()
      .then((payload) => ctx.edit(payload))
      .catch(async (e) => {
        console.error('deferred', i.data?.custom_id ?? i.data?.name, e);
        await ctx.edit(W.errorMessage('Nem sikerült betölteni.')).catch(() => {});
      })
      .finally(() => console.log(`[timing] ${i.data?.custom_id ?? i.data?.name} ${Date.now() - started}ms`)),
  );
  return ephemeralNew ? json({ type: R.DEFERRED_MESSAGE, data: { flags: 64 } }) : json({ type: R.DEFERRED_UPDATE });
}

export async function POST(request) {
  const raw = await request.text();
  const ok = verifySignature(raw, request.headers.get('x-signature-ed25519'), request.headers.get('x-signature-timestamp'));
  if (!ok) return new Response('invalid request signature', { status: 401 });

  const i = JSON.parse(raw);
  if (i.type === T.PING) return json({ type: R.PONG });
  if (i.guild_id !== GUILD_ID()) return reply({ flags: 64, content: 'Ez a bot csak a Pandemonium szerveren működik.' });

  try {
    if (i.type === T.COMMAND) return onCommand(i);
    if (i.type === T.COMPONENT) return onComponent(i);
    if (i.type === T.MODAL) return onModal(i);
  } catch (e) {
    console.error(e);
    return (i.type === T.COMMAND ? reply : update)(W.errorMessage('Váratlan hiba.'));
  }
  return new Response('unknown interaction', { status: 400 });
}

const adminOpts = (member) => (member ? { admin: { name: displayName(member) } } : undefined);
const loadHome = (ctx, note) => async () => {
  const [rec, member] = await Promise.all([getMember(ctx.userId), targetMember(ctx)]);
  return W.homeMessage(rec, note, adminOpts(member));
};

function onCommand(i) {
  if (i.data.name === 'karakter') return deferred(context(i, ''), { ephemeralNew: true }, loadHome(context(i, '')));
  if (i.data.name === 'roster-admin' || i.data.name === 'Roster szerkesztése') {
    if (!isOfficer(i)) return reply({ flags: 64, content: 'Ehhez Officer jog kell (Rangok kezelése).' });
    const target = i.data.target_id ?? i.data.options?.find((o) => o.name === 'tag')?.value;
    if (!target || i.data.resolved?.users?.[target]?.bot) return reply({ flags: 64, content: 'Válassz egy tagot (botot nem lehet).' });
    const ctx = context(i, `t${target}.`);
    // Diagnosztika: a válasz (csak a kiadónak látható üzenet) abban a csatornában jelenik meg, ahonnan a parancs jött.
    console.log(`[admin] ${i.data.name} channel=${i.channel?.name ?? i.channel_id} channelType=${i.channel?.type} context=${i.context}`);
    return deferred(ctx, { ephemeralNew: true }, loadHome(ctx));
  }
  if (i.data.name === 'parositas') {
    if (!isOfficer(i)) return reply({ flags: 64, content: 'Ehhez Officer jog kell (Rangok kezelése).' });
    const q = cleanQuery(i.data.options?.find((o) => o.name === 'nev')?.value);
    return pairing(i, q ? 'g:q' : 'g:list:0', q ? [q] : [], true);
  }
  return reply({ flags: 64, content: 'Ismeretlen parancs.' });
}

// Officer-párosítás (g:…): halasztott válasz, a roster frissítése a válasz után.
function pairing(i, id, values, ephemeralNew = false) {
  const started = Date.now();
  waitUntil((async () => {
    try {
      const r = await handlePairing(id, values);
      await editOriginal(i.token, r.payload);
      if (r.after) await r.after().catch((e) => console.error('pairing after', e));
    } catch (e) {
      console.error('pairing', id, e);
      await editOriginal(i.token, { content: '', embeds: [{ title: 'Nem sikerült', description: e.userMessage ?? 'Váratlan hiba. Próbáld újra.', color: 0xed4245 }], components: [{ type: 1, components: [{ type: 2, style: 2, custom_id: 'g:list:0', label: 'Vissza a listához' }] }] }).catch(() => {});
    } finally {
      console.log(`[timing] ${id} ${Date.now() - started}ms`);
    }
  })());
  return json(ephemeralNew ? { type: R.DEFERRED_MESSAGE, data: { flags: 64 } } : { type: R.DEFERRED_UPDATE });
}

// Tagfelvétel (tgf:…): a jelentkezés gombja bárkinek működik, a lezárás csak Officernek.
function onTgfComponent(i) {
  const [, action, userId, outcome] = i.data.custom_id.split(':');
  if (action === 'apply') return json({ type: R.MODAL, data: applyModal() });
  if (!isOfficer(i)) return reply({ flags: 64, content: 'A jelentkezést csak Officer zárhatja le.' });
  if (action === 'close') return reply(closeConfirm(userId));
  if (action === 'close2') {
    const closer = displayName(i.member);
    waitUntil((async () => {
      try {
        let ranks = [];
        if (outcome === 'ok') {
          ranks = await memberClanRanks(userId);
          if (ranks && !ranks.length) {
            await editOriginal(i.token, closeConfirm(userId, '⚠️ A tagnak még nincs klánrangja. Előbb add meg (jobb klikk a tagon → Rangok), aztán zárd le újra.'));
            return;
          }
        }
        await editOriginal(i.token, { content: `🔒 Lezárva (${outcome === 'ok' ? 'felvéve' : 'nem vettük fel'}), a csatorna pár másodperc múlva törlődik.`, components: [] }).catch(() => {});
        await closeApplication(userId, i.channel_id, closer, { outcome, ranks: ranks ?? [] });
      } catch (e) {
        console.error('tgf close', e);
        await editOriginal(i.token, { content: '⚠️ Nem sikerült lezárni. Próbáld újra, vagy töröld a csatornát kézzel.', components: [] }).catch(() => {});
      }
    })());
    return json({ type: R.DEFERRED_UPDATE });
  }
  return reply({ flags: 64, content: 'Ismeretlen művelet.' });
}

function onTgfSubmit(i) {
  const answers = Object.fromEntries(TGF_FIELDS.map((f) => [f.id, (readModalValue(i.data.components, f.id) ?? '').trim()]));
  const started = Date.now();
  waitUntil(
    submitApplication(i.member, answers)
      .then((payload) => editOriginal(i.token, payload))
      .catch(async (e) => {
        console.error('tgf submit', e);
        await editOriginal(i.token, { content: '⚠️ Nem sikerült létrehozni a jelentkezésed csatornáját. Írj egy Officernek, vagy próbáld újra később.' }).catch(() => {});
      })
      .finally(() => console.log(`[timing] tgf:submit ${Date.now() - started}ms`)),
  );
  return json({ type: R.DEFERRED_MESSAGE, data: { flags: 64 } });
}

function onComponent(i) {
  if (i.data.custom_id?.startsWith('tgf:')) return onTgfComponent(i);
  if (i.data.custom_id?.startsWith('g:')) {
    if (!isOfficer(i)) return reply({ flags: 64, content: 'Ehhez Officer jog kell.' });
    // A kereső felugró ablak azonnal nyílik (nem kell hozzá tárolt adat).
    if (i.data.custom_id.startsWith('g:search')) return json({ type: R.MODAL, data: searchModal(i.data.custom_id.split(':').slice(2).join(':')) });
    return pairing(i, i.data.custom_id, i.data.values);
  }
  const ctx = context(i);
  if (ctx.denied) return reply({ flags: 64, content: 'Ehhez Officer jog kell.' });
  const { id, userId } = ctx;
  const value = i.data.values?.[0];
  // A #roster üzenet gombjai nyilvános üzenethez tartoznak: ott új ephemeral üzenettel válaszolunk.
  const fromRoster = !(i.message?.flags & 64);
  const show = fromRoster ? ctx.reply : ctx.update;
  const upd = ctx.update;

  if (id === 'refresh') {
    waitUntil(syncGuild({ minAgeMs: 10 * 60_000 }).then(() => publishRoster()).catch((e) => console.error('refresh', e)));
    return reply({ flags: 64, content: '🔄 A roster frissítése elindult (a Blizzard armory adataival együtt), pár másodperc múlva látszik.' });
  }

  if (id === 'menu:home') return deferred(ctx, { ephemeralNew: fromRoster }, loadHome(ctx));
  if (id === 'menu:alt') return deferred(ctx, {}, async () => W.altMessage(await getMember(userId), Number(value), adminOpts(await targetMember(ctx))));
  if (id === 'menu:delall') return upd(W.confirmDeleteMessage());

  if (id === 'menu:delall2') {
    waitUntil(commit(ctx, () => null, ctx.target ? 'Az adatokat töröltem.' : 'Az adataidat töröltem.'));
    return upd(W.savingMessage());
  }
  if (id.startsWith('menu:delalt:')) {
    const idx = Number(id.split(':')[2]);
    waitUntil(commit(ctx, (rec) => rec && { ...rec, alts: rec.alts.filter((_, k) => k !== idx) }, `Az Alt ${idx + 1} törölve.`));
    return upd(W.savingMessage());
  }

  const parts = id.split(':');

  if (parts[0] === 'w') {
    const [, slot, step, ...rest] = parts;
    if (!W.isSlot(slot)) return upd(W.errorMessage('Érvénytelen választás.'));
    switch (step) {
      case 'start':
        return show(W.stepRole(slot));
      case 'r': // szerep kiválasztva → class
        return upd(W.stepClass(slot, value));
      case 'r2': // vissza a classválasztásra
        return upd(W.stepClass(slot, rest[0]));
      case 'c': // class kiválasztva → spec (ha csak egy lehetséges, átugorjuk)
      case 'c2': {
        const [Rk] = rest;
        const C = Number(step === 'c' ? value : rest[1]);
        const specs = specsFor(C, Rk);
        if (specs.length === 1) return upd(step === 'c' ? W.stepOff(slot, Rk, C, specs[0].index) : W.stepClass(slot, Rk));
        return upd(W.stepSpec(slot, Rk, C));
      }
      case 'p': // spec kiválasztva → offspec
        return upd(W.stepOff(slot, rest[0], Number(rest[1]), Number(value)));
      case 'o2':
        return upd(W.stepOff(slot, rest[0], Number(rest[1]), Number(rest[2])));
      case 'o': { // offspec kiválasztva → összegzés (a meglévő nevet betöltjük)
        const [Rk, Cs, Ps] = rest;
        const k = W.parseKey([slot, Rk, Cs, Ps, value]);
        return deferred(ctx, {}, async () => {
          const rec = W.normalize(await getMember(userId));
          const existing = slot === 'm' ? rec?.main?.name : rec?.alts?.[Number(slot.slice(1))]?.name;
          return W.stepFinish(slot, Rk, k.C, k.P, k.O, existing);
        });
      }
    }
  }

  if (parts[0] === 'n') {
    const k = W.parseKey(parts.slice(1));
    return json({ type: R.MODAL, data: ctx.tag(W.nameModal(k.key, k.slot, k.name)) });
  }

  if (parts[0] === 'v') {
    const k = W.parseKey(parts.slice(1));
    waitUntil(saveChar(ctx, k, k.name));
    return upd(W.savingMessage());
  }

  return upd(W.errorMessage('Ismeretlen művelet.'));
}

function onModal(i) {
  if (i.data.custom_id === 'tgf:submit') return onTgfSubmit(i);
  if (i.data.custom_id === 'g:q') {
    if (!isOfficer(i)) return reply({ flags: 64, content: 'Ehhez Officer jog kell.' });
    return pairing(i, 'g:q', [cleanQuery(readModalValue(i.data.components, 'query'))]);
  }
  const ctx = context(i);
  if (ctx.denied) return reply({ flags: 64, content: 'Ehhez Officer jog kell.' });
  const parts = ctx.id.split(':');
  if (parts[0] !== 'm') return ctx.update(W.errorMessage('Ismeretlen űrlap.'));
  const k = W.parseKey(parts.slice(1));
  const name = W.cleanName(readModalValue(i.data.components, 'name')) || null;
  waitUntil(saveChar(ctx, k, name));
  return ctx.update(W.savingMessage());
}

function readModalValue(components, customId) {
  for (const c of components ?? []) {
    if (c.custom_id === customId) return c.value;
    if (c.component?.custom_id === customId) return c.component.value;
    const inner = readModalValue(c.components, customId);
    if (inner != null) return inner;
  }
  return null;
}

function saveChar(ctx, k, name) {
  const { userId } = ctx;
  const ch = { role: k.R, cls: k.C, spec: k.P, off: k.O === 'x' ? null : k.O, name };
  return commit(ctx, (rec) => {
    const base = rec ?? { userId, alts: [] };
    if (k.slot === 'm') return { ...base, userId, main: ch };
    if (!base.main) throw new Error('Altot csak main után lehet megadni.');
    const idx = Number(k.slot.slice(1));
    const alts = [...base.alts];
    if (idx < alts.length) alts[idx] = ch;
    else if (alts.length < W.MAX_ALTS) alts.push(ch);
    else throw new Error('Elérted a maximális altszámot.');
    return { ...base, userId, alts };
  }, '✅ Mentve.');
}

// Olvasás → módosítás → tárolás → rangok igazítása → roster frissítése → az ephemeral üzenet lecserélése.
async function commit(ctx, mutate, note) {
  const { i, userId } = ctx;
  const started = Date.now();
  try {
    // Admin módban a cél-tag rangjait (és nevét) a Discordtól kérjük le, nem a kattintóét használjuk.
    const [stored, member] = await Promise.all([getMember(userId), targetMember(ctx)]);
    const rec = W.normalize(stored);
    const next = mutate(rec);
    if (next?.main) await saveMember(next);
    else await deleteMember(userId).catch(() => {});
    let roleNote = '';
    try {
      await syncRoles(userId, (member ?? i.member).roles ?? [], next);
    } catch (e) {
      console.error('syncRoles', e);
      roleNote = ctx.target ? '\n⚠️ A tag rangjait nem sikerült beállítani.' : '\n⚠️ A rangjaidat nem sikerült beállítani, szólj egy Officernek.';
    }
    // Előbb a felhasználó kapja meg az eredményt, a roster frissítése utána jön.
    await ctx.edit(W.homeMessage(next?.main ? next : null, note + roleNote, adminOpts(member)));
    await publishRoster().catch((e) => console.error('publishRoster', e));
  } catch (e) {
    console.error('commit', e);
    await ctx.edit(W.errorMessage(e.message?.startsWith('Alt') || e.message?.startsWith('Elérted') ? e.message : 'Nem sikerült menteni.')).catch(() => {});
  } finally {
    console.log(`[timing] commit ${i.data?.custom_id} ${Date.now() - started}ms`);
  }
}
