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

export async function POST(request) {
  const raw = await request.text();
  const ok = verifySignature(raw, request.headers.get('x-signature-ed25519'), request.headers.get('x-signature-timestamp'));
  if (!ok) return new Response('invalid request signature', { status: 401 });

  const i = JSON.parse(raw);
  if (i.type === T.PING) return json({ type: R.PONG });
  if (i.guild_id !== GUILD_ID()) return reply({ flags: 64, content: 'Ez a bot csak a Pandemonium szerveren működik.' });

  try {
    if (i.type === T.COMMAND) return await onCommand(i);
    if (i.type === T.COMPONENT) return await onComponent(i);
    if (i.type === T.MODAL) return await onModal(i);
  } catch (e) {
    console.error(e);
    return (i.type === T.COMMAND ? reply : update)(W.errorMessage('Váratlan hiba.'));
  }
  return new Response('unknown interaction', { status: 400 });
}

async function onCommand(i) {
  if (i.data.name === 'karakter') return reply(W.homeMessage(await getMember(i.member.user.id)));
  return reply({ flags: 64, content: 'Ismeretlen parancs.' });
}

async function onComponent(i) {
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

  if (id === 'menu:home') return show(W.homeMessage(await getMember(userId)));

  if (id === 'menu:delall') return update(W.confirmDeleteMessage());

  if (id === 'menu:delall2' || id === 'menu:delalt') {
    const rec = await getMember(userId);
    const next = id === 'menu:delalt' && rec ? { ...rec, alt: null } : null;
    waitUntil(commit(i, userId, next, id === 'menu:delalt' ? 'Az altodat töröltem.' : 'Az adataidat töröltem.'));
    return update(W.savingMessage());
  }

  const parts = id.split(':');

  if (parts[0] === 'w') {
    const [, slot, step, ...rest] = parts;
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
        if (specs.length === 1) {
          return update(step === 'c' ? W.stepOff(slot, Rk, C, specs[0].index) : W.stepClass(slot, Rk));
        }
        return update(W.stepSpec(slot, Rk, C));
      }
      case 'p': // spec kiválasztva → offspec
        return update(W.stepOff(slot, rest[0], Number(rest[1]), Number(value)));
      case 'o': // offspec kiválasztva → összegzés
      case 'o2': {
        const [Rk, Cs, Ps] = rest;
        if (step === 'o2') return update(W.stepOff(slot, Rk, Number(Cs), Number(Ps)));
        const { O } = W.parseKey([slot, Rk, Cs, Ps, value]);
        const rec = await getMember(userId);
        const existing = slot === 'm' ? rec?.main?.name : rec?.alt?.name;
        return update(W.stepFinish(slot, Rk, Number(Cs), Number(Ps), O, existing));
      }
    }
  }

  if (parts[0] === 'n') {
    const key = parts.slice(1).join(':');
    W.parseKey(parts.slice(1));
    const rec = await getMember(userId);
    const existing = parts[1] === 'm' ? rec?.main?.name : rec?.alt?.name;
    return json({ type: R.MODAL, data: W.nameModal(key, parts[1], existing) });
  }

  if (parts[0] === 'v') {
    const k = W.parseKey(parts.slice(1));
    const rec = await getMember(userId);
    const existing = k.slot === 'm' ? rec?.main?.name : rec?.alt?.name;
    waitUntil(saveChar(i, userId, k, existing ?? null));
    return update(W.savingMessage());
  }

  return update(W.errorMessage('Ismeretlen művelet.'));
}

async function onModal(i) {
  const parts = i.data.custom_id.split(':');
  if (parts[0] !== 'm') return update(W.errorMessage('Ismeretlen űrlap.'));
  const k = W.parseKey(parts.slice(1));
  const name = readModalValue(i.data.components, 'name')?.trim().slice(0, 24) || null;
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

async function saveChar(i, userId, k, name) {
  const rec = (await getMember(userId)) ?? { userId };
  const ch = { role: k.R, cls: k.C, spec: k.P, off: k.O === 'x' ? null : k.O, name };
  const next = { ...rec, userId, [k.slot === 'm' ? 'main' : 'alt']: ch };
  return commit(i, userId, next, '✅ Mentve.');
}

// Tárolás → rangok igazítása → roster frissítése → az ephemeral üzenet lecserélése az eredményre.
async function commit(i, userId, next, note) {
  try {
    if (next?.main) await saveMember(next);
    else await deleteMember(userId).catch(() => {});
    let roleNote = '';
    try {
      await syncRoles(userId, i.member.roles ?? [], next);
    } catch (e) {
      console.error('syncRoles', e);
      roleNote = '\n⚠️ A rangjaidat nem sikerült beállítani, szólj egy Officernek.';
    }
    await publishRoster().catch((e) => console.error('publishRoster', e));
    await editOriginal(i.token, W.homeMessage(next?.main ? next : null, note + roleNote));
  } catch (e) {
    console.error('commit', e);
    await editOriginal(i.token, W.errorMessage('Nem sikerült menteni.')).catch(() => {});
  }
}
