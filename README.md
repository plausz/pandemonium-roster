# Pandemonium Roster bot

Discord-bot Vercelen (HTTP interactions, nincs állandóan futó folyamat). Élő cím: https://pandemonium-roster.vercel.app

- `/karakter` parancs vagy a #roster **✏️ gombja** → lépésenként: szerep → class (csak a szerephez illők) → main spec → offspec (opcionális) → karakternév (opcionális). Ugyanígy **legfeljebb 4 alt** (➕ gomb; meglévő alt módosítása/törlése a lenyíló listából).
- Mentéskor a bot **beállítja a rangokat**: szerep-rang a main és az offspec alapján (🛡️ Tank / 💚 Healer / 🗡️ DPS), class-rang a main és az összes alt alapján. A klánrangokhoz (Panda, Friends…) nem nyúl.
- A **#roster** két üzenete minden mentéskor frissül: (1) Panda roster a mainekkel (és akik még nem töltötték ki) + **class-eloszlás** (mind a 9 class: darab, arány, sáv, Panda altok száma, hiányzó classok) + a többi rang statisztikája, (2) **Panda alt roster** szerepek szerint. A gombok (✏️, 🔄) az alt roster alatt vannak.
- **Class-színek:** a roster soraiban és a class-eloszlásban minden karakter előtt Blizzard class-színű kör áll. Ezek a bot saját (alkalmazás-) emojijai, a bot az első frissítéskor magától feltölti őket (`lib/png.js` rajzolja, `lib/emojis.js` tölti fel); amíg nincsenek meg, színes unicode jelek helyettesítik.
- **Blizzard guild-szinkron** (opcionális): ha a `BLIZZARD_CLIENT_ID` és `BLIZZARD_CLIENT_SECRET` be van állítva, a napi karbantartás, a `/api/cron` kézi hívása és a #roster 🔄 gombja (utóbbi legfeljebb 10 percenként) lekéri a Pändemonium guild tagjait és a karakterek szintjét / item levelét a hivatalos API-ból (`profile-forever-eu`). A rosterben a teljes névvel megadott karakterek mellé kiírja a szintet és az ilvl-t, az alt roster alá pedig guild-blokk kerül: class-megoszlás, legmagasabb szint, és a **rosterben nem szereplő guildkarakterek** listája. Forever: a karakterek csak 10. szinttől és kilépés után látszanak az API-ban. Hiba esetén a roster a korábbi adatokkal frissül.
- **Guild-párosítás:** a rosterkaraktereket a bot a Blizzard guildkarakterekhez rendeli: pontos teljes név → teljes név ékezet nélkül → keresztnév (azonos keresztnévnél a class dönt) → név nélküli karakternél a tag **Discord-neve + class** (a Discord-név valamelyik ≥3 betűs szava egyezik a kereszt- vagy vezetéknévvel). Csak egyértelmű találatot fogad el; a Discord-név alapján talált (automatikus) párosítás **dőlt** névvel jelenik meg.
- **Officer mód:** `/roster-admin tag:@valaki` vagy jobb klikk a tagon → Alkalmazások → **Roster szerkesztése**. Ugyanaz a varázsló nyílik meg a kiválasztott tag nevében (main, altok, nevek, törlés); a mentés az ő rangjait állítja. Csak *Rangok kezelése* (vagy Adminisztrátor) joggal látszik és működik – a bot minden kattintásnál újra ellenőrzi. A gombok custom_id-je ilyenkor `t<tagId>.` előtagot kap.
- **Guild-párosítás officereknek (`/parositas`):** listázza a Blizzard guild-listából a rosterben még nem szereplő karaktereket. Egy karakter kiválasztása után Discord-tagot választasz, majd: a tag meglévő mainjének/altjának nevét a guildkarakterre állítod (csak azonos classnál), új mainként/altként felveszed (spec választással, rangkiosztással), vagy a bot **DM-ben megkéri**, hogy töltse ki. Egy gombbal emlékeztető DM megy minden Pandának, aki még nem töltötte ki (megerősítés után). A DM sikertelen, ha a tag letiltotta a szerver-tagoktól érkező üzeneteket – ezt a bot jelzi.
- **Armory-link:** ha a karakternév teljes (Forever: „Név Vezetéknév”, legfeljebb 32 karakter), a rosterben a név a **hivatalos Blizzard Forever armoryra** mutat (`https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/character/nev-vezeteknev`). A Foreverben nincsenek realmok, a karaktert a teljes név azonosítja; csak keresztnévhez nincs link. A #roster gombjai között **🏰 Guild armory** gomb is van (Pändemonium guild oldal). Mindkettő cserélhető: `ARMORY_URL` (`{slug}` helyőrzővel), `GUILD_ARMORY_URL`.
- Ami tárolt adatot olvas (parancs, Vissza, összegzés, alt kiválasztása), az halasztott válasszal megy, így hidegindításnál sem lépi túl a Discord 3 mp-es határát. A futásidők a Vercel naplóban `[timing]` sorként látszanak.
- **Napi karbantartás** (03:00 UTC): a szerverről kilépett tagok adatai törlődnek, a roster újraépül.

## Fájlok
| Fájl | Szerep |
|---|---|
| `api/interactions.js` | Discord interakciók (parancs, gombok, menük, modal) |
| `api/setup.js` | `/karakter`, `/roster-admin` és a „Roster szerkesztése” menüpont regisztrálása + roster üzenet kitétele (`/api/setup?secret=…`) |
| `api/cron.js` | Napi karbantartás + Blizzard guild-szinkron |
| `lib/pairing.js` | Officer guild-párosítás (`/parositas`) és DM-emlékeztetők |
| `lib/blizzard.js` | Hivatalos Blizzard API (OAuth, guild roster, karakterprofil) |
| `lib/emojis.js`, `lib/png.js` | Class-színű bot-emojik rajzolása és feltöltése |
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
| `SETUP_SECRET`, `CRON_SECRET` | opcionális; ha be vannak állítva, a setup és a cron csak ezzel indítható |
| `BLOB_READ_WRITE_TOKEN` | automatikusan, amikor a Blob tárat a projekthez kötöd |
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` | opcionális; develop.battle.net → API Access → kliens (a secret **titkos**, „Sensitive” típusként add meg). Enélkül a guild-szinkron ki van kapcsolva |
| `BLIZZARD_GUILD` | opcionális; a guild neve a Blizzard API-ban (alapértelmezés: `Pändemonium`) |
| `ARMORY_URL`, `GUILD_ARMORY_URL` | opcionális; karakter-armory minta `{slug}` helyőrzővel, illetve a guild armory címe (alapértelmezés: hivatalos Blizzard Forever armory, Pändemonium) |

## Telepítés (egyszer)
1. **Discord Developer Portal** → New Application („Pandemonium Roster”). Bot fülön: **Server Members Intent** bekapcsolása.
2. **Vercel**: a mappából `npx vercel@latest deploy --prod` (projektnév: `pandemonium-roster`).
3. Vercel → Storage → **Blob** tár létrehozása **Private** hozzáféréssel, összekötés a projekttel.
4. Környezeti változók beállítása, majd újratelepítés.
5. Bot meghívása a szerverre (*Manage Roles*, *View Channels*, *Send Messages*, *Embed Links* jog); a bot rangja kerüljön a szerep- és class-rangok **fölé**.
6. Developer Portal → General Information → **Interactions Endpoint URL**: `https://<projekt>.vercel.app/api/interactions`
7. Böngészőben: `https://<projekt>.vercel.app/api/setup` (ha van SETUP_SECRET: `?secret=…`) → regisztrálja a parancsot és kiteszi a rostert.

## Teszt
`npm install && npm test`
