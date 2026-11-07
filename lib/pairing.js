import { CLASSES, ROLES, specsFor, specLabel, describeChar, classIcon, setClassIcons, armoryUrlForSlug } from './data.js';
import { dc, displayName, GUILD_ID } from './discord.js';
import { getMember, saveMember, getConfig } from './store.js';
import { rosterState, publishRoster } from './roster.js';
import { syncRoles } from './roles.js';
import { normalize, MAX_ALTS } from './wizard.js';

// Officer-párosítás: a Blizzard guild-listából a rosterben még nem szereplő karakterek hozzárendelése Discord-tagokhoz,
// vagy a tag megkérése (DM), hogy töltse ki a rostert. Minden custom_id „g:” kezdetű; a jogosultságot a hívó ellenőrzi.
//   g:list:<oldal>[:<keresés>]           lista (lenyíló menü: g:pick); keresés: g:search gomb → modal → g:q
//   g:pick            (érték: slug)      karakter → tagválasztó (g:who:<slug>)
//   g:who:<slug>      (érték: userId)    a tag adatai + műveletek
//   g:set:<slug>:<userId>:<m|aN>         meglévő main/alt nevének beállítása a guildkarakter nevére
//   g:new:<slug>:<userId>:<m|a>          új main/alt a guildkarakterből → spec választás (g:spec:…)
//   g:spec:<slug>:<userId>:<m|a> (érték: spec index)
//   g:dm:<userId>:<slug>                 a tag megkérése DM-ben
//   g:remind / g:remind2                 emlékeztető minden ki nem töltött Pandának (megerősítéssel)
//   g:back:<slug>, g:back2:<slug>:<userId>

const PAGE = 20;
const QUERY_MAX = 40;
const fold = (s) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('hu');
export const cleanQuery = (q) => (q ?? '').replace(/[:|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX);
const COLOR = 0xe67e22;
const row = (...components) => ({ type: 1, components });
const button = (custom_id, label, style = 2, emoji, disabled = false) => ({ type: 2, custom_id, label: label.slice(0, 80), style, disabled, ...(emoji ? { emoji: { name: emoji } } : {}) });
const msg = (title, description, components) => ({ flags: 64, content: '', embeds: [{ title, description, color: COLOR }], components });

class UserError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

// Lenyíló menü opció ikonja: a bot class-emojija ({ id, name }) vagy a tartalék unicode jel.
function optionEmoji(cls) {
  if (cls < 0) return undefined;
  const icon = classIcon(cls);
  const m = icon.match(/^<:(\w+):(\d+)>$/);
  return m ? { name: m[1], id: m[2] } : { name: icon };
}
const charLine = (g) => `${g.cls >= 0 ? classIcon(g.cls) : '▫️'} [**${g.name}**](${armoryUrlForSlug(g.slug)}) · ${g.cls >= 0 ? CLASSES[g.cls].name : '?'} · ${g.level ?? '?'}. szint${g.ilvl ? ` · ilvl ${g.ilvl}` : ''}`;

async function loadState() {
  const cfg = await getConfig();
  setClassIcons(cfg.classEmojis);
  return rosterState();
}

function findChar(state, slug) {
  const g = state.guildData?.members?.find((x) => x.slug === slug);
  if (!g) throw new UserError('Ez a karakter már nincs a guild-listában (frissítsd a Blizzard-szinkront).');
  return g;
}

// Névkereső felugró ablak (a lista 🔍 gombja nyitja).
export function searchModal(current = '') {
  return {
    custom_id: 'g:q',
    title: 'Keresés a guildkarakterek között',
    components: [row({ type: 4, custom_id: 'query', style: 1, label: 'Név vagy névrészlet (üresen: teljes lista)', required: false, max_length: QUERY_MAX, ...(current ? { value: current } : {}) })],
  };
}

export function listScreen(state, page = 0, note = '', query = '') {
  if (!state.guildData?.members?.length) {
    return msg('🧩 Guild-párosítás', 'Még nincs Blizzard guild-adat. Futtasd a szinkront (🔄 a #roster alatt), majd próbáld újra.', []);
  }
  const q = cleanQuery(query);
  const list = q ? state.unmatched.filter((g) => fold(g.name).includes(fold(q))) : state.unmatched;
  const qs = q ? `:${q}` : '';
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * PAGE, (p + 1) * PAGE);
  const lines = [
    note ? `${note}\n` : '',
    q
      ? `🔍 Keresés: **${q}** — ${list.length} találat a rosterben nem szereplő ${state.unmatched.length} karakter közül.${list.length ? '' : ' Próbálj rövidebb névrészletet.'}`
      : `**${list.length}** guildkarakter nincs még a rosterben (${state.guildData.members.length}-ből). Válassz egyet a listából, majd add meg, melyik Discord-taghoz tartozik.`,
    `**${state.missingPandas.length}** Panda még egyáltalán nem töltötte ki a rostert${state.missingPandas.length ? `: ${state.missingPandas.map(displayName).sort((a, b) => a.localeCompare(b, 'hu')).join(', ')}` : '.'}`,
  ].filter(Boolean);
  const components = [];
  if (slice.length) {
    components.push(row({
      type: 3,
      custom_id: 'g:pick',
      placeholder: `Guildkarakter kiválasztása… (${p + 1}/${pages}. oldal)`,
      options: slice.map((g) => ({
        label: g.name.slice(0, 100),
        description: `${g.cls >= 0 ? CLASSES[g.cls].name : '?'} · ${g.level ?? '?'}. szint${g.ilvl ? ` · ilvl ${g.ilvl}` : ''}`.slice(0, 100),
        value: g.slug,
        emoji: optionEmoji(g.cls),
      })),
    }));
  }
  components.push(row(
    button(`g:list:${p - 1}${qs}`, 'Előző', 2, '◀️', p === 0),
    button(`g:list:${p + 1}${qs}`, 'Következő', 2, '▶️', p >= pages - 1),
    button(`g:search${qs}`, q ? 'Új keresés' : 'Keresés', 1, '🔍'),
    ...(q ? [button('g:list:0', 'Teljes lista', 2, '✖️')] : [button(`g:list:${p}`, 'Frissítés', 2, '🔄')]),
  ));
  components.push(row(button('g:remind', `Emlékeztető a ki nem töltötteknek (${state.missingPandas.length})`, 2, '📨', !state.missingPandas.length)));
  return msg('🧩 Guild-párosítás (officer)', lines.join('\n').slice(0, 4000), components);
}

function charScreen(g) {
  return msg('🧩 Kié ez a karakter?', `${charLine(g)}\n\nVálaszd ki a Discord-tagot, akihez tartozik. A következő lépésben eldöntheted, hogy a mainje vagy egy altja legyen, vagy megkérheted, hogy ő maga töltse ki.`, [
    row({ type: 5, custom_id: `g:who:${g.slug}`, placeholder: 'Discord-tag kiválasztása…', min_values: 1, max_values: 1 }),
    row(button('g:list:0', 'Vissza a listához', 2, '↩️')),
  ]);
}

function memberScreen(g, userId, member, rawRec, note = '') {
  const rec = normalize(rawRec);
  const name = member ? displayName(member) : 'ismeretlen tag';
  const sameClass = (ch) => ch.cls === g.cls;
  const lines = [
    note ? `${note}\n` : '',
    charLine(g),
    `**Tag:** ${name}`,
    `**Main:** ${rec?.main ? describeChar(rec.main) : '_még nincs megadva_'}`,
    ...(rec?.alts ?? []).map((a, i) => `**Alt ${i + 1}:** ${describeChar(a)}`),
    '',
    'A meglévő karakter nevét csak azonos classnál lehet a guildkarakterre állítani. Új karakternél a következő lépésben a specet választod ki.',
  ].filter((l, i) => l !== '' || i > 2);
  const set = [];
  if (rec?.main) set.push(button(`g:set:${g.slug}:${userId}:m`, `Main legyen ez${sameClass(rec.main) ? '' : ' (más class)'}`, 3, '⚔️', !sameClass(rec.main)));
  (rec?.alts ?? []).forEach((a, i) => set.push(button(`g:set:${g.slug}:${userId}:a${i}`, `Alt ${i + 1} legyen ez${sameClass(a) ? '' : ' (más class)'}`, 3, '🔁', !sameClass(a))));
  const more = [];
  if (!rec?.main) more.push(button(`g:new:${g.slug}:${userId}:m`, 'Felvétel mainként', 1, '➕'));
  else more.push(button(`g:new:${g.slug}:${userId}:a`, `Felvétel új altként (${rec.alts.length}/${MAX_ALTS})`, 1, '➕', rec.alts.length >= MAX_ALTS));
  more.push(button(`g:dm:${userId}:${g.slug}`, 'Megkérem, hogy töltse ki', 2, '📨'));
  more.push(button(`g:back:${g.slug}`, 'Másik tag', 2, '↩️'));
  more.push(button('g:list:0', 'Lista', 2, '📋'));
  return msg('🧩 Hozzárendelés', lines.join('\n'), [...(set.length ? [row(...set)] : []), row(...more)]);
}

function specScreen(g, userId, slot, name) {
  return msg('🧩 Melyik spec?', `${charLine(g)}\n**Tag:** ${name}\n\nA Blizzard nem adja meg a specet, ezért válaszd ki, milyen szerepben játszik vele (később a tag a ✏️ gombbal módosíthatja).`, [
    row({
      type: 3,
      custom_id: `g:spec:${g.slug}:${userId}:${slot}`,
      placeholder: 'Spec kiválasztása…',
      options: specsFor(g.cls).map((sp) => ({ label: specLabel(g.cls, sp.index), value: String(sp.index), emoji: { name: ROLES[sp.role].emoji } })),
    }),
    row(button(`g:back2:${g.slug}:${userId}`, 'Vissza', 2, '↩️')),
  ]);
}

const getDiscordMember = (userId) => dc('GET', `/guilds/${GUILD_ID()}/members/${userId}`).catch(() => null);

async function sendReminderDm(userId, g) {
  const channel = await dc('POST', '/users/@me/channels', { recipient_id: userId });
  const roster = process.env.ROSTER_CHANNEL_ID ? `<#${process.env.ROSTER_CHANNEL_ID}>` : 'a #roster';
  const charHint = g ? `\nA guildben láttuk ezt a karaktert: **${g.name}** (${g.cls >= 0 ? CLASSES[g.cls].name : '?'}). Ha a tiéd, add meg mainként vagy altként.` : '';
  await dc('POST', `/channels/${channel.id}/messages`, {
    content: `Szia! 🐼 A Pandemonium officerei kérnek, hogy add meg a karaktereidet a ${roster} csatornában (✏️ gomb), **teljes névvel** (Név Vezetéknév). Így látjuk a raidtervezéshez, ki mivel jön, és a neved mellett megjelenik a szinted, az item leveled és az armory-linked.${charHint}\nKöszi!`,
    allowed_mentions: { parse: [] },
  });
}

async function saveFor(userId, mutate) {
  const rec = normalize(await getMember(userId));
  const next = mutate(rec);
  await saveMember(next);
  return next;
}

// Egy „g:” interakció feldolgozása. Visszaad: { payload, after? } – az after a roster frissítése a válasz után.
export async function handlePairing(id, values = []) {
  const parts = id.split(':');
  const op = parts[1];
  const value = values[0];
  const state = await loadState();

  if (op === 'list') return { payload: listScreen(state, Number(parts[2]) || 0, '', parts.slice(3).join(':')) };
  if (op === 'q') return { payload: listScreen(state, 0, '', value) };
  if (op === 'pick') return { payload: charScreen(findChar(state, value)) };
  if (op === 'back') return { payload: charScreen(findChar(state, parts[2])) };

  if (op === 'who' || op === 'back2') {
    const g = findChar(state, parts[2]);
    const userId = op === 'who' ? value : parts[3];
    const [member, rec] = await Promise.all([getDiscordMember(userId), getMember(userId)]);
    if (!member) throw new UserError('Ez a felhasználó nincs a szerveren.');
    if (member.user?.bot) throw new UserError('Botot nem lehet kiválasztani.');
    return { payload: memberScreen(g, userId, member, rec) };
  }

  if (op === 'set') {
    const [, , slug, userId, slot] = parts;
    const g = findChar(state, slug);
    const member = await getDiscordMember(userId);
    const who = member ? displayName(member) : userId;
    await saveFor(userId, (rec) => {
      if (!rec?.main) throw new UserError('A tagnak nincs még mainje.');
      const target = slot === 'm' ? rec.main : rec.alts[Number(slot.slice(1))];
      if (!target) throw new UserError('Ez a karakter már nem létezik.');
      if (target.cls !== g.cls) throw new UserError('A class nem egyezik.');
      target.name = g.name;
      return rec;
    });
    const fresh = await rosterState();
    const note = `✅ **${g.name}** → ${who} ${slot === 'm' ? 'mainje' : `Alt ${Number(slot.slice(1)) + 1}`}.`;
    return { payload: listScreen(fresh, 0, note), after: () => publishRoster() };
  }

  if (op === 'new') {
    const [, , slug, userId, slot] = parts;
    const g = findChar(state, slug);
    if (g.cls < 0) throw new UserError('A karakter classa ismeretlen.');
    const member = await getDiscordMember(userId);
    return { payload: specScreen(g, userId, slot, member ? displayName(member) : userId) };
  }

  if (op === 'spec') {
    const [, , slug, userId, slot] = parts;
    const g = findChar(state, slug);
    const spec = Number(value);
    const sp = CLASSES[g.cls]?.specs[spec];
    if (!sp) throw new UserError('Érvénytelen spec.');
    const ch = { role: sp[1], cls: g.cls, spec, off: null, name: g.name };
    let asMain = false;
    const next = await saveFor(userId, (rec) => {
      const base = rec ?? { userId, alts: [] };
      if (slot === 'm' && base.main) throw new UserError('A tagnak időközben lett mainje; vedd fel altként.');
      if (!base.main) {
        asMain = true;
        return { ...base, userId, main: ch };
      }
      if (base.alts.length >= MAX_ALTS) throw new UserError('A tagnak már 4 altja van.');
      return { ...base, userId, alts: [...base.alts, ch] };
    });
    const member = await getDiscordMember(userId);
    let roleNote = '';
    try {
      await syncRoles(userId, member?.roles ?? [], next);
    } catch (e) {
      console.error('pairing syncRoles', e);
      roleNote = ' ⚠️ A rangjait nem sikerült beállítani.';
    }
    const fresh = await rosterState();
    const note = `✅ **${g.name}** felvéve ${member ? displayName(member) : userId} ${asMain ? 'mainjeként' : 'altjaként'}.${roleNote}`;
    return { payload: listScreen(fresh, 0, note), after: () => publishRoster() };
  }

  if (op === 'dm') {
    const [, , userId, slug] = parts;
    const g = findChar(state, slug);
    const [member, rec] = await Promise.all([getDiscordMember(userId), getMember(userId)]);
    let note;
    try {
      await sendReminderDm(userId, g);
      note = `📨 Üzenetet küldtem neki (${member ? displayName(member) : userId}).`;
    } catch (e) {
      console.error('pairing dm', e);
      note = '⚠️ Nem sikerült üzenetet küldeni (valószínűleg letiltotta a szerver-tagoktól érkező DM-eket). Írj neki te, vagy jelöld meg egy csatornában.';
    }
    return { payload: memberScreen(g, userId, member, rec, note) };
  }

  if (op === 'remind') {
    const names = state.missingPandas.map(displayName).sort((a, b) => a.localeCompare(b, 'hu'));
    return {
      payload: msg('📨 Emlékeztető küldése', `A bot privát üzenetben megkéri ezt a **${names.length}** Pandát, hogy töltse ki a rostert:\n${names.join(', ') || '—'}\n\nBiztosan elküldöd?`, [
        row(button('g:remind2', `Igen, küldés (${names.length})`, 1, '📨', !names.length), button('g:list:0', 'Mégse', 2)),
      ]),
    };
  }

  if (op === 'remind2') {
    const sent = [];
    const failed = [];
    for (const m of state.missingPandas) {
      try {
        await sendReminderDm(m.user.id, null);
        sent.push(displayName(m));
      } catch (e) {
        console.error('remind dm', m.user.id, e.message);
        failed.push(displayName(m));
      }
    }
    const note = `📨 Elküldve: ${sent.length}${failed.length ? ` · Nem sikerült (DM tiltva?): ${failed.join(', ')}` : ''}`;
    return { payload: listScreen(state, 0, note) };
  }

  throw new UserError('Ismeretlen művelet.');
}

export { UserError };
