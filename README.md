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

Nema build koraka: `index.html` + `app.js` + `style.css`, biblioteke (three.js, SunCalc) s CDN-a. Sama 3D karta (teren,
zgrade, zelenilo, vode, ulice, stabla, svjetlo, sjene i kamera) dolazi iz zasebnog repozitorija
[zagreb-dedede](https://github.com/zkristo/zagreb-dedede) (`https://zagreb-dedede.zvonimir-kristo.workers.dev`);
ova aplikacija dodaje kafiće, njihovo sunce i sjenu, klizač i popise. `?map=…` učitava modul karte s druge adrese
(npr. lokalne kopije), `?tiles=…` detaljne zgrade.

## Podaci

| Datoteka | Izvor | Alat |
| --- | --- | --- |
| `data/cafes.json` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) doprinositelji (ODbL), Overpass API; kafići kojih nema u OSM-u iz [Overture Maps](https://overturemaps.org/) (CDLA-Permissive-2.0, samo pouzdanost ≥ 0,8); obzor svake terase iz zgrada i terena karte | `python3 tools/fetch_overture.py` (treba `pip install duckdb`), zatim `python3 tools/build_cafes.py` |
| sve ostalo (zgrade, teren, zelenilo, ulice, vode, stabla) | vidi README repozitorija zagreb-dedede | |

Alati trebaju `pip install -r tools/requirements.txt` i preuzete datoteke spremaju u `tools/cache/` (obriši mapu za
svježe podatke). Zgrade i teren preuzimaju se s objavljene karte (`MAP_DATA` u `tools/common.py`; kopija starija od
12 h preuzima se ponovno), pa su obzori terasa uvijek izračunati na karti koju korisnici vide. Popis kafića osvježava
se sam prvog u mjesecu (GitHub Actions, `.github/workflows/refresh-cafes.yml`; može se pokrenuti i ručno u kartici
Actions).

## Ograničenja modela

- Zgrade su prizme od tla do najviše točke krova (`Z_Max`), pa su sjene kosih krovova malo predugačke.
- Teren je mreža od 20 m (dalje od 2 km od kamere crta se svaka druga točka): uz zgrade izveden iz njihovih podnožja (podrumske „jame” ispravljene prema modelu DGU-a),
  više od 300–600 m od zgrada iz digitalnog modela reljefa DGU-a (20 m, golo tlo bez krošanja i zgrada). Tendi i suncobrana nema.
- Stabla iz katastra su samo ona s javnih površina, većinom stanje iz 2016.; OpenStreetMap dodaje oko 15 000 stabala iz vrtova i dvorišta (bez oznaka veličine pretpostavljeno 8 m visine i krošnje); visina i širina krošnje poznate su samo kao razredi, pa je svako stablo elipsoid približne veličine. Listopadna stabla bacaju sjenu od 1. ožujka do 30. studenoga. Terasa koju zaklanja samo krošnja prikazuje se zasebno („pod krošnjom”).
- Sjena zgrada i terena računa se unaprijed: svaki kafić u `cafes.json` nosi svoj „obzor” (`tools/skyline.py`) —
  najveći kut iznad horizonta do kojeg sežu krovovi ili tlo, za svaki stupanj smjera. Terasa je u sjeni kad je sunce
  niže od obzora u svom smjeru.
- OSM točka kafića obično je unutar zgrade, pa se pomiče na najbliži otvoreni prostor — to je procjena položaja terase.
