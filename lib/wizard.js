import { CLASSES, ROLES, ROLE_ORDER, classesForRole, specsFor, specLabel, describeChar } from './data.js';

// A varázsló állapota a gombok/menük custom_id-jében utazik, így lépések között nincs mit tárolni.
// Formátum: w:<slot>:<lépés>:<R>:<C>:<P>  (slot: m = main, a = alt)

const EPHEMERAL = 64;
const SLOT = { m: 'Main', a: 'Alt' };

const row = (...components) => ({ type: 1, components });
const button = (custom_id, label, style = 2, emoji) => ({ type: 2, custom_id, label, style, ...(emoji ? { emoji: { name: emoji } } : {}) });
const select = (custom_id, placeholder, options) => row({ type: 3, custom_id, placeholder, min_values: 1, max_values: 1, options: options.slice(0, 25) });

function msg(title, description, components, color = 0x2b7bb9) {
  return { flags: EPHEMERAL, content: '', embeds: [{ title, description, color }], components };
}

export function homeMessage(rec, note) {
  const hasMain = !!rec?.main;
  const lines = [
    note ? `${note}\n` : '',
    `**Main:** ${hasMain ? describeChar(rec.main) : '_még nincs megadva_'}`,
    `**Alt:** ${rec?.alt ? describeChar(rec.alt) : '_nincs_'}`,
    '',
    'A szerep- és class-rangjaidat a bot ez alapján állítja be. A karakternév megadása nem kötelező.',
  ];
  const buttons = [button('w:m:start', hasMain ? 'Main módosítása' : 'Main megadása', 1, '⚔️')];
  if (hasMain) buttons.push(button('w:a:start', rec.alt ? 'Alt módosítása' : 'Alt hozzáadása', 2, '🧪'));
  if (rec?.alt) buttons.push(button('menu:delalt', 'Alt törlése', 2, '🗑️'));
  if (hasMain) buttons.push(button('menu:delall', 'Adataim törlése', 4));
  return msg('🐼 Karaktereid', lines.join('\n'), [row(...buttons)]);
}

export function confirmDeleteMessage() {
  return msg('Biztosan törlöd?', 'A main és az alt adataid törlődnek a rosterből, és a bot leveszi rólad a szerep- és class-rangokat.', [
    row(button('menu:delall2', 'Igen, törlés', 4), button('menu:home', 'Mégse', 2)),
  ], 0xed4245);
}

export function stepRole(slot) {
  return msg(`${SLOT[slot]} — 1/4: szerep`, 'Milyen szerepben szeretnél játszani ezzel a karakterrel?', [
    select(`w:${slot}:r`, 'Válassz szerepet', ROLE_ORDER.map((r) => ({ label: ROLES[r].label, value: r, emoji: { name: ROLES[r].emoji } }))),
    row(button('menu:home', 'Vissza', 2)),
  ]);
}

export function stepClass(slot, R) {
  return msg(`${SLOT[slot]} — 2/4: class`, `Szerep: ${ROLES[R].emoji} ${ROLES[R].label}\nCsak azok a classok jelennek meg, amelyek ezt a szerepet tudják.`, [
    select(`w:${slot}:c:${R}`, 'Válassz classt', classesForRole(R).map((c) => ({ label: c.name, value: String(c.index) }))),
    row(button(`w:${slot}:start`, 'Vissza', 2)),
  ]);
}

export function stepSpec(slot, R, C) {
  const specs = specsFor(C, R);
  return msg(`${SLOT[slot]} — 3/4: main spec`, `${ROLES[R].emoji} ${ROLES[R].label} · ${CLASSES[C].name}`, [
    select(`w:${slot}:p:${R}:${C}`, 'Válassz specet', specs.map((s) => ({ label: specLabel(C, s.index), value: String(s.index) }))),
    row(button(`w:${slot}:r2:${R}`, 'Vissza', 2)),
  ]);
}

export function stepOff(slot, R, C, P) {
  const options = specsFor(C)
    .filter((s) => s.index !== P)
    .map((s) => ({ label: specLabel(C, s.index), value: String(s.index), emoji: { name: ROLES[s.role].emoji } }));
  options.push({ label: 'Nincs offspec', value: 'x' });
  return msg(`${SLOT[slot]} — 4/4: offspec`, `${ROLES[R].emoji} ${specLabel(C, P)} ${CLASSES[C].name}\nVan offspeced? (Nem kötelező.)`, [
    select(`w:${slot}:o:${R}:${C}:${P}`, 'Válassz offspecet', options),
    row(button(`w:${slot}:c2:${R}:${C}`, 'Vissza', 2)),
  ]);
}

export function stepFinish(slot, R, C, P, O, existingName) {
  const ch = { role: R, cls: C, spec: P, off: O === 'x' ? null : O, name: existingName ?? null };
  const key = `${slot}:${R}:${C}:${P}:${O}`;
  return msg(`${SLOT[slot]} — összegzés`, `${describeChar(ch)}\n\nAdd meg a karakter nevét (nem kötelező), vagy mentsd így.`, [
    row(
      button(`n:${key}`, existingName ? 'Név módosítása' : 'Karakternév megadása', 1, '📝'),
      button(`v:${key}`, existingName ? `Mentés (${existingName})` : 'Mentés név nélkül', 3, '✅'),
      button(`w:${slot}:o2:${R}:${C}:${P}`, 'Vissza', 2),
    ),
  ]);
}

export function nameModal(key, slot, existingName) {
  return {
    custom_id: `m:${key}`,
    title: `${SLOT[slot]} karakter neve`,
    components: [
      row({ type: 4, custom_id: 'name', style: 1, label: 'Karakternév (nem kötelező)', required: false, max_length: 24, ...(existingName ? { value: existingName } : {}) }),
    ],
  };
}

export function savingMessage() {
  return msg('Mentés…', 'Mentem az adataidat, beállítom a rangjaidat és frissítem a #roster csatornát.', []);
}

export function errorMessage(text) {
  return msg('Hiba történt', `${text}\n\nPróbáld újra, vagy szólj egy Officernek.`, [row(button('menu:home', 'Vissza', 2))], 0xed4245);
}

// "R:C:P:O" kulcsból karakter-objektum (ellenőrzéssel).
export function parseKey(parts) {
  const [slot, R, Cs, Ps, Os] = parts;
  const C = Number(Cs);
  const P = Number(Ps);
  const O = Os === 'x' ? 'x' : Number(Os);
  const cls = CLASSES[C];
  if (!SLOT[slot] || !ROLES[R] || !cls || !cls.specs[P] || cls.specs[P][1] !== R) throw new Error('Érvénytelen választás');
  if (O !== 'x' && (!cls.specs[O] || O === P)) throw new Error('Érvénytelen offspec');
  return { slot, R, C, P, O };
}
