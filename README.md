# Tiny Terra

### Team Name
- SHELF

### Track Number & Name
- Track IV: Living Worlds & Simulations

### Problem Statement Name
- Tiny Terra

### Idea
- Tiny Terra turns any word into a miniature planet. Type a word (or roll the dice) and a world forms with oceans, continents, mountains, forests, deserts, rivers, snow and ice, drifting clouds and, sometimes, rings.
- The same word always builds the same planet, so a seed can be shared with friends through a link.
- Explore it as a rotating globe or a flat map. Sunlight sweeps across the planet in a day-night cycle, and city lights or lava glow on the night side.
- Temperature, water level and terrain sliders reshape the planet live. A hot world spreads into deserts and a cold one freezes over. A climate time-lapse shows the ice caps advancing and retreating.
- Each planet gets an ID card with a generated name, world type, habitability score and an explorer's log. Planets can be saved as postcards.
- Every planet comes with a mission picked from its seed (for example "Freeze a third of the surface" or "Make it a Paradise"). A progress bar fills as you move the sliders, and completing it earns a star and a chime.
- Every planet also has its own sound: an ambient hum whose chord comes from the seed, an ocean swell that follows the water level, and gentle sound effects for every control (mute with the speaker button or `A`).

![Tiny Terra showing a ringed Earth-like planet](docs/preview.jpg)

### How to Run
- **Prerequisites:** any modern web browser (Chrome, Edge, Firefox or Safari). Nothing else is needed: no server, no internet connection and no API keys. Node.js is optional and only used to run the self-checks from a terminal.
- **Installation steps:** none. Clone or download the repository; there are no dependencies to install and no build step.
- **Exact commands to run the project locally:**

```bash
git clone https://github.com/jnanottamgy/SHELF_The_Exchange.git
cd SHELF_The_Exchange
```

Then open `index.html` in a browser (double-clicking it also works):

```bash
# macOS
open index.html
# Windows
start index.html
# Linux
xdg-open index.html
```

Optional self-checks (25 checks on the planet engine): open `tests.html` in a browser, or run:

```bash
node js/tests.js
```

---

#### Controls
Drag to spin, scroll or pinch to zoom, hover or tap to inspect a spot.

| Key | Action |
| --- | --- |
| `R` | Random planet |
| `/` | Type a seed |
| `M` | Globe or map |
| `Space` | Pause day and night |
| `T` | Climate time-lapse |
| `A` | Sound on or off |
| `C`, `L`, `G` | Clouds, night lights, grid |
| `1`–`6` | Climate presets |
| `S`, `P` | Share link, postcard |
| `?` | Help |

#### Project structure
```
index.html      App markup
css/style.css   Styling (no external fonts or assets)
js/terra.js     Planet engine: deterministic, no DOM
js/app.js       Rendering, interaction and UI
js/audio.js     Sound, synthesised live with the Web Audio API (no audio files)
js/tests.js     Self-check suite (browser and Node)
tests.html      Self-check page
docs/           README image
```
