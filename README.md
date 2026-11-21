# Sunčane terase

3D karta cijelog Zagreba (svih 17 gradskih četvrti, sa Savom, ulicama i prugama) u stvarnom vremenu: koje su terase kafića trenutno na suncu, a koje u sjeni.

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
| `data/cafes.json` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL), Overpass API; kafići kojih nema u OSM-u iz [Overture Maps](https://overturemaps.org/) (CDLA-Permissive-2.0, samo pouzdanost ≥ 0,8) | `python3 tools/fetch_overture.py` (treba `pip install duckdb`), zatim `python3 tools/build_cafes.py` |
| `data/trees.json` | Katastar zelenila Grada Zagreba ([javni ArcGIS sloj](https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/stablo_SpatialJoin/FeatureServer), bez navedene licence) | `python3 tools/build_trees.py` |
| `data/map.json` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL): vode, ulice, pruge i tramvajske pruge | `python3 tools/build_map.py` |

Alati koriste samo standardnu biblioteku Pythona (osim `fetch_overture.py`, kojem treba DuckDB), a preuzete datoteke spremaju u `tools/cache/`
(obriši mapu za svježe podatke — i nakon promjene područja, jer imena spremljenih datoteka ne ovise o njemu).
Četvrti su popisane u `DISTRICTS` u `tools/build_buildings.py`. Popis kafića osvježava se sam prvog u mjesecu
(GitHub Actions, `.github/workflows/refresh-cafes.yml`; može se pokrenuti i ručno u kartici Actions).

## Ograničenja modela

- Zgrade su prizme od tla do najviše točke krova (`Z_Max`), pa su sjene kosih krovova malo predugačke.
- Teren je gruba mreža izvedena iz podnožja zgrada; tendi i suncobrana nema.
- Stabla su samo ona s javnih površina, većinom stanje iz 2016.; visina i širina krošnje poznate su samo kao razredi, pa je svako stablo elipsoid približne veličine. Listopadna stabla bacaju sjenu od 15. travnja do 31. listopada. Terasa koju zaklanja samo krošnja prikazuje se zasebno („pod krošnjom”).
- OSM točka kafića obično je unutar zgrade, pa se pomiče na najbliži otvoreni prostor — to je procjena položaja terase.
