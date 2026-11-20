# FM27 Moneyball Scout (macOS Apple Silicon)

A Mustermann-inspired, stats-only **Moneyball scouting dashboard** and **in-game FM27 launch button** for macOS (Apple Silicon).

Reads your `.fm` save file directly via [`fmsave`](https://github.com/rhiever/fmsave) — **zero CA/PA or hidden attribute spoilers**, **progressive season-by-season archiving**, and **one-click refresh** from inside Football Manager 27.

---

## Features

- **In-Game FM27 Button (`FM27MoneyballButton.dll`)**: Injects an amber **Moneyball** button into FM27's UI (`UnityEngine.UIElements`) via BepInEx 6 IL2CPP. Clicking it starts the local server (if needed) and opens your live scouting dashboard.
- **Direct `.fm` Save Pickup**: Automatically picks your newest non-backup `.fm` save in `~/Library/Application Support/Sports Interactive/Football Manager 27/games/` (or lets you switch saves in the top bar).
- **Progressive Season Archive**: Saves each season under `scouting/seasons/<YYYY-YY>/` (e.g. `2027-28`, `2028-29`), so you can switch seasons and inspect **Season-by-Season Progression** inside player profiles.
- **Mustermann-Style Analytics**:
  - Aggregates `kind=league` stats across multi-club transfers and recomputes per-90 rates from raw totals.
  - Filters to men's clubs (matching men's saves) with configurable minimum minutes (`900+` default), age, transfer value, weekly wage, contract expiry, and club reputation.
  - Dynamic `0–100` peer-group percentiles and position-specific role scores (`GK`, `CB`, `FB/WB`, `DM`, `CM`, `AM`, `W`, `ST`).
  - Interactive **Per-90 Scatter Plot**, **10-axis SVG Radar Chart** with current-club benchmark comparison, **Shortlist**, and **CSV Export** (compatible with Excel / Google Sheets / Numbers).

---

## Requirements

- **macOS** on **Apple Silicon** (M1 or newer)
- **Football Manager 27** on **Steam**
- **Python 3.12+** (e.g. `brew install python@3.14`)
- **.NET SDK** (for building the BepInEx button plugin: `brew install dotnet`)
- **[FM27] BepInEx 6 IL2CPP for macOS** (`FM27-BepInEx`, available on Sortitoutsi)

---

## Setup

### 1. Clone and install Python dependencies

```bash
git clone https://github.com/chilliesdev/fm27-moneyball-mac.git
cd fm27-moneyball-mac
./install.sh
```

`install.sh` creates `.venv`, installs `fmsave`, builds your initial season snapshot from your newest FM27 save (if present), and builds/installs `FM27MoneyballButton.dll` if `FM27-BepInEx/BepInEx/interop` already exists.

### 2. Install BepInEx 6 for FM27 (one-time)

1. Download **`[FM27] BepInEx 6 IL2CPP for macOS`** (by `sptndc` / `codexx01`) from Sortitoutsi.
2. Unzip and place `FM27-BepInEx/` inside your Steam FM27 directory (beside `fm.app`):
   `~/Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/`
3. Make the launcher executable:
   ```bash
   chmod +x "$HOME/Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/run_fm27_bepinex.sh"
   ```
4. In **Steam → Football Manager 27 → Properties → General → Launch Options**, set:
   ```text
   "/Users/YOUR_USERNAME/Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/run_fm27_bepinex.sh" %command%
   ```
5. Launch FM27 once through Steam until the main menu loads (this generates `FM27-BepInEx/BepInEx/interop/`).

### 3. Build & install the in-game Moneyball button

```bash
./mod/FM27MoneyballButton/build.sh
```

This compiles `FM27MoneyballButton.dll` and writes `moneyball.config.txt` into `FM27-BepInEx/BepInEx/plugins/`.

Relaunch FM27 — an amber **Moneyball** button appears in the bottom-right corner.

---

## Usage

- **From inside FM27**: Save your game (`Cmd+S`), then click **Moneyball** to refresh from your current save and open `http://127.0.0.1:8727/`.
- **Standalone (without launching FM27)**:
  - Double-click `scouting/Launch_Scout.command`, or run:
    ```bash
    ./.venv/bin/python scouting/server.py
    ```
  - Rebuild a specific save from CLI:
    ```bash
    ./.venv/bin/python scouting/build_moneyball.py --pick
    ```

---

## Credits

- [`fmsave`](https://github.com/rhiever/fmsave) by Dr. Randal S. Olson (`rhiever`)
- macOS BepInEx 6 IL2CPP setup for FM26/FM27 by `sptndc` and `codexx01`
- Moneyball scouting workflow inspired by **MustermannFM**

## License

MIT
