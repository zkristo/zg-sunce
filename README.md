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
| `data/buildings.bin`, `data/terrain.bin` | [ZG3D 2022, Grad Zagreb](https://data.zagreb.hr/dataset/?q=zg3d) (Otvorena dozvola); binarni zapis s krovovima već trianguliranima (opis u `tools/common.py`); teren uz zgrade iz njihovih podnožja, dalje od njih iz [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) (© DLR e.V. 2010-2014 i © Airbus Defence and Space GmbH 2014-2018, COPERNICUS, EU i ESA) | `python3 tools/build_buildings.py` |
| `data/landmarks.json` (znamenite zgrade: ≥ 40 m ili istaknute u OSM-u) | ZG3D + © OpenStreetMap | `python3 tools/landmarks.py` (prije `build_buildings.py`) |
| detaljne 3D zgrade cijelog grada (pravi krovovi) i znamenitosti, zaseban repozitorij [zg-sunce-tiles](https://github.com/zkristo/zg-sunce-tiles) | ZG3D 2022 LoD 2.2 (FGDB/SHP multipatch), Grad Zagreb (Otvorena dozvola) | `python3 tools/build_tiles.py` u kopiju repozitorija `../zg-sunce-tiles`, zatim jedan novi commit (`git commit --amend`) i `git push --force` |
| `data/cafes.json` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL), Overpass API; kafići kojih nema u OSM-u iz [Overture Maps](https://overturemaps.org/) (CDLA-Permissive-2.0, samo pouzdanost ≥ 0,8) | `python3 tools/fetch_overture.py` (treba `pip install duckdb`), zatim `python3 tools/build_cafes.py` |
| `data/trees.json` | Katastar zelenila Grada Zagreba ([javni ArcGIS sloj](https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/stablo_SpatialJoin/FeatureServer), bez navedene licence) + © OpenStreetMap (stabla i drvoredi kojih nema u katastru, dalje od 4 m od katastarskog stabla) | `python3 tools/build_trees.py` |
| `data/map.json`, `data/landcover.bin` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL): vode, ulice, pješačke i biciklističke staze, pruge; parkovi, travnjaci i šume kao boja tla (polje udaljenosti do ruba na mreži od 10 m, pa su rubovi glatki) | `python3 tools/build_map.py` |

Alati koriste standardnu biblioteku Pythona; `fetch_overture.py` treba DuckDB, a `build_cafes.py` numpy
(`pip install -r tools/requirements.txt`), a preuzete datoteke spremaju u `tools/cache/`
(obriši mapu za svježe podatke — i nakon promjene područja, jer imena spremljenih datoteka ne ovise o njemu).
Četvrti su popisane u `DISTRICTS` u `tools/build_buildings.py`. Popis kafića osvježava se sam prvog u mjesecu
(GitHub Actions, `.github/workflows/refresh-cafes.yml`; može se pokrenuti i ručno u kartici Actions).

## Ograničenja modela

- Zgrade su prizme od tla do najviše točke krova (`Z_Max`), pa su sjene kosih krovova malo predugačke.
- Teren je mreža od 40 m: uz zgrade izveden iz njihovih podnožja (podrumske „jame” ispravljene prema Copernicus DEM-u),
  više od 300–600 m od zgrada iz Copernicus DEM-a (30 m; u šumi uključuje krošnje). Tendi i suncobrana nema.
- Stabla iz katastra su samo ona s javnih površina, većinom stanje iz 2016.; OpenStreetMap dodaje oko 15 000 stabala iz vrtova i dvorišta (bez oznaka veličine pretpostavljeno 8 m visine i krošnje); visina i širina krošnje poznate su samo kao razredi, pa je svako stablo elipsoid približne veličine. Listopadna stabla bacaju sjenu od 1. ožujka do 30. studenoga. Terasa koju zaklanja samo krošnja prikazuje se zasebno („pod krošnjom”).
- Sjena zgrada i terena računa se unaprijed: svaki kafić u `cafes.json` nosi svoj „obzor” (`tools/skyline.py`) —
  najveći kut iznad horizonta do kojeg sežu krovovi ili tlo, za svaki stupanj smjera. Terasa je u sjeni kad je sunce
  niže od obzora u svom smjeru.
- OSM točka kafića obično je unutar zgrade, pa se pomiče na najbliži otvoreni prostor — to je procjena položaja terase.
