# Sunčane terase

3D karta Zagreba (središte, Trnje i Novi Zagreb) u stvarnom vremenu: koje su terase kafića trenutno na suncu, a koje u sjeni.

- Sive zgrade + stvarne sjene za trenutni položaj sunca (osvježava se svake minute).
- Klizač za ostatak dana, prognoza „na suncu do HH:MM” za svaki kafić.
- Oznaka naoblake (Open-Meteo), popis sunčanih terasa po udaljenosti, „moja lokacija”.
- `?now=2026-06-21T10:00` u adresi pomiče sat (testiranje / dijeljenje trenutka).

## Pokretanje

```
python3 -m http.server 8000
```

Nema build koraka: `index.html` + `app.js` + `style.css`, biblioteke (three.js, three-mesh-bvh, SunCalc) s CDN-a.

## Podaci

| Datoteka | Izvor | Alat |
| --- | --- | --- |
| `data/buildings.json`, `data/terrain.json` | [ZG3D 2022, Grad Zagreb](https://data.zagreb.hr/dataset/?q=zg3d) (Otvorena dozvola) | `python3 tools/build_buildings.py` |
| `data/cafes.json` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL), Overpass API | `python3 tools/build_cafes.py` |

Alati koriste samo standardnu biblioteku Pythona, a preuzete datoteke spremaju u `tools/cache/`
(obriši mapu za svježe podatke). Novi kvartovi dodaju se u popis `CORE` u `tools/build_buildings.py`.

## Ograničenja modela

- Zgrade su prizme od tla do najviše točke krova (`Z_Max`), pa su sjene kosih krovova malo predugačke.
- Teren je gruba mreža izvedena iz podnožja zgrada; drveća, tendi i suncobrana nema.
- OSM točka kafića obično je unutar zgrade, pa se pomiče na najbliži otvoreni prostor — to je procjena položaja terase.
