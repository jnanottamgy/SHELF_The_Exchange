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
- Every planet comes with a chain of 3 missions picked from its seed (for example "Freeze a third of the surface", then "Make it a Paradise"). A progress bar fills as you move the sliders; each completed mission sets off confetti, earns a star and unlocks the next, and finishing all three masters the world. Stars build your Terraformer rank (Cadet → Explorer → Pioneer → Terraformer → World-shaper → Star-forger).
- **Planet Defense (the game):** press **Play** (or `D`). Meteors fly in from every side; click or tap them to blast them with a beam from the planet's surface before they hit. Boulders take three shots and split, golden streaks are fast, green orbs repair a shield and blue orbs clear the sky. Chain hits for up to ×8 combos; every wave is faster. After each wave you upgrade the planet's guns: pick 1 of 3 skills (Heavy beam, Wide beam, Chain lightning, Auto-turret, Gravity field, Extra shield), each up to level III. Impacts leave craters and glowing cracks that turn with the planet, and after three hits the planet shatters to its molten core. Your best score is saved.
- **Land anywhere:** press `E` over any spot (or the Land button) and the ship descends there. Walk the site in 3D under the real sky for that pin: the sun sits where the planet's rotation puts it, so you land in daylight, at sunset or at night; the weather comes from the globe's own cloud layer over that spot (clear, cloudy, overcast, rain or snow); trees cast long shadows at low sun, settlements light up at night, lava glows on scorched worlds, and ringed planets show their rings arching across the sky. `,` and `.` move the local clock an hour.
- Meteor strike: call down a meteor shower, watch the crust crack and glow, the planet shatter into tumbling pieces and its molten core appear with labelled layers. The core belongs to its world: its size, layers and material come from the seed, it runs hotter on hotter planets, rugged terrain thickens the crust, oceans and ice add outer shells, and it reacts live to the sliders. Hover or tap a layer for its depth, temperature and material. Rebuild re-forms the same planet.
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
| `H` | Photo mode (hide everything but the planet) |
| `D` | Play Planet Defense (click or tap meteors; Space or Esc pauses) |
| `E` | Land at the spot under the cursor (`,` and `.` move the local clock; `M` map or walk) |
| `K` | Meteor strike (press again to rebuild) |
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
