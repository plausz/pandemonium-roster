# Pandemonium Roster bot

Discord-bot Vercelen (HTTP interactions, nincs állandóan futó folyamat).

- `/karakter` parancs vagy a #roster üzenet **✏️ gombja** → lépésenként: szerep → class (csak a szerephez illők) → main spec → offspec (opcionális) → karakternév (opcionális). Ugyanígy egy alt.
- Mentéskor a bot **beállítja a rangokat**: szerep-rang a main és az offspec alapján (🛡️ Tank / 💚 Healer / 🗡️ DPS), class-rang a main és az alt alapján. A klánrangokhoz (Panda, Friends…) nem nyúl.
- A **#roster** üzenet minden mentéskor azonnal frissül: fent a Pandák részletesen (és akik még nem töltötték ki), alatta a többi rang statisztikája. 🔄 gomb kézi frissítéshez.
- **Napi karbantartás** (03:00 UTC): a szerverről kilépett tagok adatai törlődnek, a roster újraépül.

## Fájlok
| Fájl | Szerep |
|---|---|
| `api/interactions.js` | Discord interakciók (parancs, gombok, menük, modal) |
| `api/setup.js` | `/karakter` regisztrálása + roster üzenet kitétele (`/api/setup?secret=…`) |
| `api/cron.js` | Napi karbantartás |
| `lib/data.js` | Classok, specek, szerepek |
| `lib/roster.js` | A #roster üzenet felépítése |
| `lib/roles.js` | Rangkiosztás |
| `lib/store.js` | Adattárolás (Vercel Blob, privát) |

## Környezeti változók
| Név | Honnan |
|---|---|
| `DISCORD_APP_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information → Public Key |
| `DISCORD_TOKEN` | Developer Portal → Bot → Reset Token (**titkos**, „Sensitive” típusként add meg) |
| `GUILD_ID` | `374715859727548417` |
| `ROSTER_CHANNEL_ID` | a #roster csatorna azonosítója |
| `SETUP_SECRET`, `CRON_SECRET` | tetszőleges hosszú véletlen szöveg |
| `BLOB_READ_WRITE_TOKEN` | automatikusan, amikor a Blob tárat a projekthez kötöd |

## Telepítés (egyszer)
1. **Discord Developer Portal** → New Application („Pandemonium Roster”). Bot fülön: **Server Members Intent** bekapcsolása.
2. **Vercel**: a mappából `npx vercel@latest deploy --prod` (projektnév: `pandemonium-roster`).
3. Vercel → Storage → **Blob** tár létrehozása **Private** hozzáféréssel, összekötés a projekttel.
4. Környezeti változók beállítása, majd újratelepítés.
5. Bot meghívása a szerverre (*Manage Roles*, *View Channels*, *Send Messages*, *Embed Links* jog); a bot rangja kerüljön a szerep- és class-rangok **fölé**.
6. Developer Portal → General Information → **Interactions Endpoint URL**: `https://<projekt>.vercel.app/api/interactions`
7. Böngészőben: `https://<projekt>.vercel.app/api/setup?secret=<SETUP_SECRET>` → regisztrálja a parancsot és kiteszi a rostert.

## Teszt
`npm install && npm test`
