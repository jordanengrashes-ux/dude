# Using the official VEX CAD in the 3D view

The 3D view ships with detailed procedural models of every Override element, built
from the dimensions the physics uses (Pin 1.6" × 6.5", Cup 3.15" × 6.5", Goal socket
heights 3.25 / 5.8 / 8.7", 25.8" Toggle bars, 11.5" walls). Edge chamfers, lips,
brackets and bolt heads are modeled for realism but are not copied from official
drawings. The official STEP files can replace any of them without code changes.

The environment that built this project could not reach vexrobotics.com, so the
official files are not included. Download them yourself (VEX → Competition →
Override → Field CAD), then:

```bash
pip install cadquery-ocp                       # OpenCASCADE, one time
npm run cad:selftest                           # checks the converter (prints PASS)
npm run cad -- path/to/step-folder public/models   # every .step/.stp → .glb
```

The converter keeps part colors and names, converts millimeters to meters and Z-up to
Y-up, and prints each model's size in inches so you can check it against the frames
below. Then list the files in `public/models/manifest.json`:

```json
{
  "elements": {
    "pin": { "RY": "pin-red-yellow.glb", "BY": "pin-blue-yellow.glb", "YY": "pin-yellow-yellow.glb", "RB": "pin-red-blue.glb" },
    "cup": "cup.glb",
    "goal": { "alliance-red": "goal-alliance-red.glb", "alliance-blue": "goal-alliance-blue.glb", "neutral": "goal-short.glb", "midfield": "goal-tall.glb" },
    "toggle": { "file": "toggle.glb", "rotate": [0, 90, 0] },
    "loader": { "red": "loader-red.glb", "blue": "loader-blue.glb" },
    "perimeter": "perimeter.glb"
  }
}
```

Any element can be left out; it keeps its procedural model. Pins and Cups are swapped
together, and only when every Pin type (or a single `"pin": "file.glb"` for all types)
is given. Reload the page; the browser console prints `[cad] official models in use: …`.

## Element frames

Each GLB must be authored in (or fixed up to) the frame below. Fix-ups go in the
manifest entry as `{ "file", "rotate": [x, y, z] degrees, "translate": [x, y, z]
meters, "scale" }`, applied to the loaded model.

| Element | Origin | Axes |
|---|---|---|
| `pin` | center of the Pin | long axis +Y; the half named first in the type (R in `RY`) is the −Y half |
| `cup` | center of the Cup | axis +Y; gray half toward +Y |
| `goal` | on the floor at the Goal's axis | +Y up |
| `toggle` | on the rotation axis, middle of the bar | +Z along the axis, +X toward the field, yellow face toward the field |
| `loader` | the wall's inner face on the floor, behind the red Loader on the −x wall | +Y up; the blue Loaders are copies turned 180° |
| `perimeter` | field center on the floor | +Y up |

The world frame is meters, +Y up, field center at the origin; game +x (toward the blue
Alliance Station) is world +X and game +y is world −Z.

## How it fits together

- `scripts/cad/step_to_glb.py`: STEP → GLB via OpenCASCADE's XCAF reader and glTF
  writer. `scripts/cad/selftest.py` builds a two-color Pin-sized STEP in millimeters
  with Z up, converts it, and checks size, orientation and colors.
- `src/ui/three/cad.ts`: reads the manifest, loads each GLB once, and either
  instances it (Pins, Cups: one draw call per CAD mesh, synced to physics every frame)
  or swaps it into the element's scene node (Goals, Toggles, Loaders, perimeter).
  Toggle models ride in the physics-synced bar node, so they rotate with the
  simulated Toggle.
- Physics is unaffected: collisions use the simplified shapes in `src/physics/`.
