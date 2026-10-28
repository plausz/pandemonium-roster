import { waitUntil } from '@vercel/functions';
import { verifySignature, editOriginal, GUILD_ID } from '../lib/discord.js';
import { specsFor } from '../lib/data.js';
import { getMember, saveMember, deleteMember } from '../lib/store.js';
import { syncRoles } from '../lib/roles.js';
import { publishRoster } from '../lib/roster.js';
import * as W from '../lib/wizard.js';

const T = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL: 5 };
const R = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE: 7, MODAL: 9 };
const json = (data) => Response.json(data);
const reply = (data) => json({ type: R.MESSAGE, data });
// Meglévő üzenet frissítésekor a flags mezőt nem küldjük újra (az ephemeral jelző nem módosítható).
const strip = ({ flags, ...rest }) => rest;
const update = (data) => json({ type: R.UPDATE, data: strip(data) });

// A Discord 3 másodpercen belül választ vár. Ami tárolt adatot olvas, azt azonnal „elhalasztott” válasszal
// nyugtázzuk, és a tényleges tartalmat utólag írjuk be – így hidegindításnál sem akad el a felület.
function deferred(i, { ephemeralNew = false } = {}, work) {
  const started = Date.now();
  waitUntil(
    work()
      .then((payload) => editOriginal(i.token, payload))
      .catch(async (e) => {
        console.error('deferred', i.data?.custom_id ?? i.data?.name, e);
        await editOriginal(i.token, W.errorMessage('Nem sikerült betölteni.')).catch(() => {});
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

const loadHome = (userId, note) => async () => W.homeMessage(await getMember(userId), note);

function onCommand(i) {
  if (i.data.name === 'karakter') return deferred(i, { ephemeralNew: true }, loadHome(i.member.user.id));
  return reply({ flags: 64, content: 'Ismeretlen parancs.' });
}

function onComponent(i) {
  const id = i.data.custom_id;
  const userId = i.member.user.id;
  const value = i.data.values?.[0];
  // A #roster üzenet gombjai nyilvános üzenethez tartoznak: ott új ephemeral üzenettel válaszolunk.
  const fromRoster = !(i.message?.flags & 64);
  const show = fromRoster ? reply : update;

  if (id === 'refresh') {
    waitUntil(publishRoster().catch((e) => console.error('refresh', e)));
    return reply({ flags: 64, content: '🔄 A roster frissítése elindult, pár másodperc múlva látszik.' });
  }

  if (id === 'menu:home') return deferred(i, { ephemeralNew: fromRoster }, loadHome(userId));
  if (id === 'menu:alt') return deferred(i, {}, async () => W.altMessage(await getMember(userId), Number(value)));
  if (id === 'menu:delall') return update(W.confirmDeleteMessage());

  if (id === 'menu:delall2') {
    waitUntil(commit(i, userId, () => null, 'Az adataidat töröltem.'));
    return update(W.savingMessage());
  }
  if (id.startsWith('menu:delalt:')) {
    const idx = Number(id.split(':')[2]);
    waitUntil(commit(i, userId, (rec) => rec && { ...rec, alts: rec.alts.filter((_, k) => k !== idx) }, `Az Alt ${idx + 1} törölve.`));
    return update(W.savingMessage());
  }

  const parts = id.split(':');

  if (parts[0] === 'w') {
    const [, slot, step, ...rest] = parts;
    if (!W.isSlot(slot)) return update(W.errorMessage('Érvénytelen választás.'));
    switch (step) {
      case 'start':
        return show(W.stepRole(slot));
      case 'r': // szerep kiválasztva → class
        return update(W.stepClass(slot, value));
      case 'r2': // vissza a classválasztásra
        return update(W.stepClass(slot, rest[0]));
      case 'c': // class kiválasztva → spec (ha csak egy lehetséges, átugorjuk)
      case 'c2': {
        const [Rk] = rest;
        const C = Number(step === 'c' ? value : rest[1]);
        const specs = specsFor(C, Rk);
        if (specs.length === 1) return update(step === 'c' ? W.stepOff(slot, Rk, C, specs[0].index) : W.stepClass(slot, Rk));
        return update(W.stepSpec(slot, Rk, C));
      }
      case 'p': // spec kiválasztva → offspec
        return update(W.stepOff(slot, rest[0], Number(rest[1]), Number(value)));
      case 'o2':
        return update(W.stepOff(slot, rest[0], Number(rest[1]), Number(rest[2])));
      case 'o': { // offspec kiválasztva → összegzés (a meglévő nevet betöltjük)
        const [Rk, Cs, Ps] = rest;
        const k = W.parseKey([slot, Rk, Cs, Ps, value]);
        return deferred(i, {}, async () => {
          const rec = W.normalize(await getMember(userId));
          const existing = slot === 'm' ? rec?.main?.name : rec?.alts?.[Number(slot.slice(1))]?.name;
          return W.stepFinish(slot, Rk, k.C, k.P, k.O, existing);
        });
      }
    }
  }

  if (parts[0] === 'n') {
    const k = W.parseKey(parts.slice(1));
    return json({ type: R.MODAL, data: W.nameModal(k.key, k.slot, k.name) });
  }

  if (parts[0] === 'v') {
    const k = W.parseKey(parts.slice(1));
    waitUntil(saveChar(i, userId, k, k.name));
    return update(W.savingMessage());
  }

  return update(W.errorMessage('Ismeretlen művelet.'));
}

function onModal(i) {
  const parts = i.data.custom_id.split(':');
  if (parts[0] !== 'm') return update(W.errorMessage('Ismeretlen űrlap.'));
  const k = W.parseKey(parts.slice(1));
  const name = readModalValue(i.data.components, 'name')?.replace(/[|:]/g, '').trim().slice(0, 24) || null;
  waitUntil(saveChar(i, i.member.user.id, k, name));
  return update(W.savingMessage());
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

function saveChar(i, userId, k, name) {
  const ch = { role: k.R, cls: k.C, spec: k.P, off: k.O === 'x' ? null : k.O, name };
  return commit(i, userId, (rec) => {
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
async function commit(i, userId, mutate, note) {
  const started = Date.now();
  try {
    const rec = W.normalize(await getMember(userId));
    const next = mutate(rec);
    if (next?.main) await saveMember(next);
    else await deleteMember(userId).catch(() => {});
    let roleNote = '';
    try {
      await syncRoles(userId, i.member.roles ?? [], next);
    } catch (e) {
      console.error('syncRoles', e);
      roleNote = '\n⚠️ A rangjaidat nem sikerült beállítani, szólj egy Officernek.';
    }
    // Előbb a felhasználó kapja meg az eredményt, a roster frissítése utána jön.
    await editOriginal(i.token, W.homeMessage(next?.main ? next : null, note + roleNote));
    await publishRoster().catch((e) => console.error('publishRoster', e));
  } catch (e) {
    console.error('commit', e);
    await editOriginal(i.token, W.errorMessage(e.message?.startsWith('Alt') || e.message?.startsWith('Elérted') ? e.message : 'Nem sikerült menteni.')).catch(() => {});
  } finally {
    console.log(`[timing] commit ${i.data?.custom_id} ${Date.now() - started}ms`);
  }
}
