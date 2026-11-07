import { CLASSES, CLASS_META, emojiName } from './data.js';
import { dc, APP_ID } from './discord.js';
import { circlePng } from './png.js';

// A bot saját (alkalmazás-) emojijai: classonként egy Blizzard-színű kör. Csak a hiányzókat tölti fel,
// így ismételten is biztonságosan hívható. Visszaad: { Warrior: '<:pd_warrior:id>', … }
export async function ensureClassEmojis() {
  const existing = (await dc('GET', `/applications/${APP_ID()}/emojis`)).items ?? [];
  const byName = new Map(existing.map((e) => [e.name, e]));
  const out = {};
  for (const c of CLASSES) {
    const name = emojiName(c.name);
    let e = byName.get(name);
    if (!e) {
      const image = `data:image/png;base64,${circlePng(CLASS_META[c.name].color).toString('base64')}`;
      e = await dc('POST', `/applications/${APP_ID()}/emojis`, { name, image });
    }
    out[c.name] = `<:${name}:${e.id}>`;
  }
  return out;
}
