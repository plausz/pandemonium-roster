import { CLASSES, ROLES, ROLE_ORDER, classesForRole, specsFor, specLabel, describeChar } from './data.js';

// A varázsló állapota a gombok/menük custom_id-jében utazik, így lépések között nincs mit tárolni.
// Formátum: w:<slot>:<lépés>:<R>:<C>:<P>   slot: m = main, a0…a3 = altok
// A meglévő karakternév a lépések végén "|név" utótagként utazik, hogy a névmegadás ne igényeljen olvasást.

export const MAX_ALTS = 4;
const EPHEMERAL = 64;

export const slotLabel = (slot) => (slot === 'm' ? 'Main' : `Alt ${Number(slot.slice(1)) + 1}`);
export const isSlot = (slot) => slot === 'm' || new RegExp(`^a[0-${MAX_ALTS - 1}]$`).test(slot);

const row = (...components) => ({ type: 1, components });
const button = (custom_id, label, style = 2, emoji, disabled = false) => ({ type: 2, custom_id, label, style, disabled, ...(emoji ? { emoji: { name: emoji } } : {}) });
const select = (custom_id, placeholder, options) => row({ type: 3, custom_id, placeholder, min_values: 1, max_values: 1, options: options.slice(0, 25) });

function msg(title, description, components, color = 0x2b7bb9) {
  return { flags: EPHEMERAL, content: '', embeds: [{ title, description, color }], components };
}

// Régi (egy altos) rekordok átalakítása az új formára.
export function normalize(rec) {
  if (!rec) return null;
  const alts = Array.isArray(rec.alts) ? rec.alts.filter(Boolean) : rec.alt ? [rec.alt] : [];
  const { alt, ...rest } = rec;
  return { ...rest, alts: alts.slice(0, MAX_ALTS) };
}

export function homeMessage(rawRec, note) {
  const rec = normalize(rawRec);
  const hasMain = !!rec?.main;
  const alts = rec?.alts ?? [];
  const lines = [
    note ? `${note}\n` : '',
    `**Main:** ${hasMain ? describeChar(rec.main) : '_még nincs megadva_'}`,
    alts.length ? alts.map((a, i) => `**Alt ${i + 1}:** ${describeChar(a)}`).join('\n') : '**Alt:** _nincs_',
    '',
    `A szerep- és class-rangjaidat a bot ez alapján állítja be. Legfeljebb ${MAX_ALTS} altot adhatsz meg, a karakternév nem kötelező.`,
  ];
  const buttons = [button('w:m:start', hasMain ? 'Main módosítása' : 'Main megadása', 1, '⚔️')];
  if (hasMain) {
    buttons.push(button(`w:a${alts.length}:start`, `Alt hozzáadása (${alts.length}/${MAX_ALTS})`, 2, '➕', alts.length >= MAX_ALTS));
    buttons.push(button('menu:delall', 'Adataim törlése', 4));
  }
  const components = [row(...buttons)];
  if (alts.length) {
    components.push(select('menu:alt', 'Alt módosítása vagy törlése…', alts.map((a, i) => ({
      label: `Alt ${i + 1}: ${CLASSES[a.cls].specs[a.spec][0]} ${CLASSES[a.cls].name}`.slice(0, 100),
      description: a.name ? a.name.slice(0, 100) : undefined,
      value: String(i),
      emoji: { name: ROLES[a.role].emoji },
    }))));
  }
  return msg('🐼 Karaktereid', lines.join('\n'), components);
}

export function altMessage(rec, i) {
  const alt = normalize(rec)?.alts?.[i];
  if (!alt) return homeMessage(rec, 'Ez az alt már nem létezik.');
  return msg(`Alt ${i + 1}`, describeChar(alt), [
    row(button(`w:a${i}:start`, 'Módosítás', 1, '✏️'), button(`menu:delalt:${i}`, 'Törlés', 4, '🗑️'), button('menu:home', 'Vissza', 2)),
  ]);
}

export function confirmDeleteMessage() {
  return msg('Biztosan törlöd?', 'A main és az összes alt adatod törlődik a rosterből, és a bot leveszi rólad a szerep- és class-rangokat.', [
    row(button('menu:delall2', 'Igen, törlés', 4), button('menu:home', 'Mégse', 2)),
  ], 0xed4245);
}

export function stepRole(slot) {
  return msg(`${slotLabel(slot)} — 1/4: szerep`, 'Milyen szerepben szeretnél játszani ezzel a karakterrel?', [
    select(`w:${slot}:r`, 'Válassz szerepet', ROLE_ORDER.map((r) => ({ label: ROLES[r].label, value: r, emoji: { name: ROLES[r].emoji } }))),
    row(button('menu:home', 'Vissza', 2)),
  ]);
}

export function stepClass(slot, R) {
  return msg(`${slotLabel(slot)} — 2/4: class`, `Szerep: ${ROLES[R].emoji} ${ROLES[R].label}\nCsak azok a classok jelennek meg, amelyek ezt a szerepet tudják.`, [
    select(`w:${slot}:c:${R}`, 'Válassz classt', classesForRole(R).map((c) => ({ label: c.name, value: String(c.index) }))),
    row(button(`w:${slot}:start`, 'Vissza', 2)),
  ]);
}

export function stepSpec(slot, R, C) {
  const specs = specsFor(C, R);
  return msg(`${slotLabel(slot)} — 3/4: main spec`, `${ROLES[R].emoji} ${ROLES[R].label} · ${CLASSES[C].name}`, [
    select(`w:${slot}:p:${R}:${C}`, 'Válassz specet', specs.map((s) => ({ label: specLabel(C, s.index), value: String(s.index) }))),
    row(button(`w:${slot}:r2:${R}`, 'Vissza', 2)),
  ]);
}

export function stepOff(slot, R, C, P) {
  const options = specsFor(C)
    .filter((s) => s.index !== P)
    .map((s) => ({ label: specLabel(C, s.index), value: String(s.index), emoji: { name: ROLES[s.role].emoji } }));
  options.push({ label: 'Nincs offspec', value: 'x' });
  return msg(`${slotLabel(slot)} — 4/4: offspec`, `${ROLES[R].emoji} ${specLabel(C, P)} ${CLASSES[C].name}\nVan offspeced? (Nem kötelező.)`, [
    select(`w:${slot}:o:${R}:${C}:${P}`, 'Válassz offspecet', options),
    row(button(`w:${slot}:c2:${R}:${C}`, 'Vissza', 2)),
  ]);
}

const cleanName = (name) => (name ? name.replace(/[|:]/g, '').trim().slice(0, 24) : '');

export function stepFinish(slot, R, C, P, O, existingName) {
  const name = cleanName(existingName);
  const ch = { role: R, cls: C, spec: P, off: O === 'x' ? null : O, name: name || null };
  const key = `${slot}:${R}:${C}:${P}:${O}`;
  return msg(`${slotLabel(slot)} — összegzés`, `${describeChar(ch)}\n\nAdd meg a karakter nevét (nem kötelező), vagy mentsd így.`, [
    row(
      button(`n:${key}|${name}`, name ? 'Név módosítása' : 'Karakternév megadása', 1, '📝'),
      button(`v:${key}|${name}`, name ? `Mentés (${name})` : 'Mentés név nélkül', 3, '✅'),
      button(`w:${slot}:o2:${R}:${C}:${P}`, 'Vissza', 2),
    ),
  ]);
}

export function nameModal(key, slot, existingName) {
  const name = cleanName(existingName);
  return {
    custom_id: `m:${key}`,
    title: `${slotLabel(slot)} karakter neve`,
    components: [
      row({ type: 4, custom_id: 'name', style: 1, label: 'Karakternév (nem kötelező)', required: false, max_length: 24, ...(name ? { value: name } : {}) }),
    ],
  };
}

export function loadingMessage() {
  return msg('Betöltés…', 'Egy pillanat.', []);
}

export function savingMessage() {
  return msg('Mentés…', 'Mentem az adataidat, beállítom a rangjaidat és frissítem a #roster csatornát.', []);
}

export function errorMessage(text) {
  return msg('Hiba történt', `${text}\n\nPróbáld újra, vagy szólj egy Officernek.`, [row(button('menu:home', 'Vissza', 2))], 0xed4245);
}

// "slot:R:C:P:O[|név]" kulcsból választás (ellenőrzéssel).
export function parseKey(parts) {
  const joined = parts.join(':');
  const [keyPart, name = ''] = joined.split('|');
  const [slot, R, Cs, Ps, Os] = keyPart.split(':');
  const C = Number(Cs);
  const P = Number(Ps);
  const O = Os === 'x' ? 'x' : Number(Os);
  const cls = CLASSES[C];
  if (!isSlot(slot) || !ROLES[R] || !cls || !cls.specs[P] || cls.specs[P][1] !== R) throw new Error('Érvénytelen választás');
  if (O !== 'x' && (!cls.specs[O] || O === P)) throw new Error('Érvénytelen offspec');
  return { slot, R, C, P, O, key: keyPart, name: cleanName(name) || null };
}
