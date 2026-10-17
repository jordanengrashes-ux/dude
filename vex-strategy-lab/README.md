# VEX V5 Strategy Lab — Override (2026–2027)

A browser-based simulator, strategy optimizer and team-play arena for the V5RC
**Override** game (game manual v2.1). One to four robots play on a correctly scaled
12 × 12 ft field in a deterministic rigid-body physics simulation (Rapier). The
rules engine scores every state and explains each point. An optimizer searches for
the best plan and reports honestly whether it is proven optimal. Bots fill any
robot nobody is driving, and players can join a room to take them over.

## Quick start

```bash
cd vex-strategy-lab
npm ci
npm run dev        # http://localhost:5173
npm test           # unit, physics, planner, team-mode tests
npm run build      # type-check + production build into dist/
npm run report     # reproducible sample report → docs/sample-report.md / .json
npm run plans      # re-plan the default match → src/sim/defaultPlans.json
```

Node 20+ is recommended.

## Deploying

The app is a static site; `vercel.json` is ready. On Vercel, import the repository,
set **Root Directory** to `vex-strategy-lab`, and deploy (framework: Vite, output
`dist`). Any static host works (`npm run build`, serve `dist/`).

**GitHub Pages.** The repository's Pages site is `https://jordanengrashes-ux.github.io/dude/`,
and the app lives at `/dude/strategy-lab/`. `npm run build:pages` builds into
`dist-pages/` with every URL under that prefix (Vite's `--base`). Copy the contents
of `dist-pages/` into `strategy-lab/` on the branch Pages publishes from and push. The
branch already has `.nojekyll`. To serve from another path, build with
`npx vite build --base /<repo>/<folder>/` and keep both slashes.

Online team mode talks directly from the browser to Supabase Realtime, so there is no
server to deploy. Supabase cannot host the app itself: it serves `.html` files as
plain text. The defaults in `src/net/config.ts` point at the project's Supabase
instance with its publishable key, which is designed to ship in client code. To use
another project, set these at build time:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
```

Realtime broadcast and presence need no tables. Rooms are public channels, so the
project's **Realtime Settings → Allow public access** must stay on (it is on by
default); turning it off enforces private channels, which would need Supabase Auth
and RLS policies on `realtime.messages`.

## Team mode

A room opens by itself when the page loads, and the address bar becomes its invite
link (`…/?room=CODE`; the header has **copy invite link**). Whoever opens the link
joins: they replace a bot (the host's partner first, then the opponents), get the
3rd-person camera on their robot, and the match starts. If nobody is hosting the
linked room (its host left or reloaded), the visitor hosts it. Online rooms use
Supabase Realtime; if it can't be reached, the room links tabs of the same browser.

- Anyone can switch to a free robot from the **Drivers** card, or **Hand back to
  bot**. When a player leaves (or disappears for more than 6 s), the bot takes the
  robot back and replans from the current field.
- During Autonomous every robot runs its program, as in a real match; drivers take
  over at Driver Control (all match in Driver Skills).
- With players in the room, the next match starts 10 s after one ends.
- Without guests, the same controls let you drive any robot while bots play the rest.

How it works: the host runs the only simulation (fixed 1/120 s steps) and streams
compact snapshots about 8 times a second: positions in millimeters, quantized
quaternions, only the objects that moved, and a keyframe every 2 s. Guests render
150 ms behind and interpolate. They send their controls when those change, plus a
heartbeat. A host alone in its room sends nothing, and a four-player room stays
inside Supabase's free-plan Realtime budget (100 messages/s). Keep the host's tab
open; if it is hidden, the match keeps running on timer ticks.

## Controls

Press W A S D on the field to take over your robot (your slot, or the first one a
bot drives); the camera locks behind it in 3rd person (mouse wheel: distance).

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Drive / turn (arcade) | W/S, A/D or arrows | left stick Y / right stick X |
| Arm up / down (DR4B) | Shift / Space (also R / F) | RT / LT |
| Arm presets: floor, Alliance Goal, short Goal, tall Goal | 1 2 3 4 | D-pad ↓ ← → ↑ |
| Claw: close (grab what is in front) / open (let go) | left click or C | A |
| Open the claw (drop) | E | B |
| Toggle arm (hold) | T | X |
| Swap pockets | Q | LB |
| Flip the held object | X | Y |
| Request a Match Load | L | RB |
| Play / pause (host or offline) | P | Start |

## The bots

Every robot of both alliances runs an optimized plan by default (scripted strategies
remain selectable in Setup). The plans are made jointly and the same way for both
alliances (`planScenario`):

- Partners coordinate: within an alliance robots plan in turn, each seeing its
  partner's plan, so they don't chase the same Pins and Cups.
- Opponents respond simultaneously: first each alliance plans on its own, then
  both re-plan against the other's previous plans (two rounds). Neither alliance
  gets the last word.
- There is no stable "best for both" to converge to: in Override the last Toggle
  flip and the Midfield majority decide who scores the yellow halves, so best
  responses keep flipping (more rounds make it swing, not settle). Each robot's
  plan is the best its search found against what it expects the others to do; the
  values shown under the score are those expectations, not predictions.

Plans for the default match ship with the app (`src/sim/defaultPlans.json`,
regenerated by `npm run plans`; a test checks they are current), so the match
starts at once. Any other setup is planned in a Web Worker (about 15 s for four
robots); the robots wait at their starting positions until their plans arrive.

On the field, each bot follows its plan with replanning. Robots yield to robots in
front of them, route around robots that stand in their path, wait briefly when
another robot occupies their target, and back off and re-route when blocked. A
virtual fence keeps them out of poses that break SG7 in Autonomous or enter the
opposing Load Zones in Driver Control; violations left are from being pushed.

## The robot

The default robot is the given 16 × 16 in four-wheel drive with a **double reverse
four-bar (DR4B)** lift; rack and pinion is still selectable in the Robot tab.
Unknowns are labeled as assumptions and editable:
- 8.5 in bars over −25°…50° (20.2 in of travel)
- 2 × 200 rpm lift motors at 1:7
- 3.25 in wheels on 450 rpm
- 15 lb

The DR4B end effector rises straight up, h = h(θmin) + 2L(sin θ − sin θmin). The
motor sees an effective radius of 2L·cos θ, so the lift is fastest with the bars
level and strongest near the top. The planner's lift times, the physics lift motor
and the animated linkage all use the same transmission (`src/robot/lift.ts`).

Execution overheads (alignment, settling, backing off) are calibrated from physics
runs; **Calibrate model from physics** in the Robot tab re-runs this for your robot.

## Optimizer

- **Model:** macro-actions (pick, load, place, toggle, park, wait) timed by the
  motor/traction model over planned paths. Values come from the rules engine on the
  resulting field, including other robots' predicted actions and the Autonomous Bonus.
- **Search methods:**
  - beam search ranked with a value-of-time term
  - MCTS
  - evolutionary search
  - branch-and-bound with an admissible bound
  - exhaustive enumeration on small scenarios
  - MPC replanning while executing
- **Reporting:** "verified optimum" only when branch-and-bound exhausts the stated
  space; otherwise best found, the bound and the gap.
- **Robustness:** model Monte Carlo (motor, traction, battery, positioning, other
  robots' timing) and full physics trials. Both theoretical-best and practical-best
  plans are reported.

`npm run report` reproduces `docs/sample-report.md` with every number from real runs.

## Rules and sources

`src/rules/ruleset.ts` lists each implemented rule with its source, manual version,
verification level and last-checked date (also shown in the Rules tab). The official
VEX sites could not be opened from the build environment, so the rules come from
search-engine extracts of the manual and Q&A. Items marked as assumptions or
conflicting are editable under Setup → Rule interpretation switches. Re-verify
against the current manual before relying on them.

## 3D models and official CAD

Field elements and robots are detailed procedural models built from the published
dimensions:
- Pins 1.6 × 6.5 in, Cups 3.15 × 6.5 in
- octagonal Goals on element plates
- 25.8 in tri-color Toggle bars on 11.5 in walls

The official STEP files can replace any of them: `docs/CAD.md` covers
`npm run cad`, the converter self-test and `public/models/manifest.json`.

## Project map

| Path | What |
|---|---|
| `src/rules/` | Override rules, scoring with explanations, timing, inspection, sources |
| `src/field/` | Field geometry and object layout |
| `src/robot/` | Robot config, motors, kinematics, lift transmission |
| `src/physics/` | Rapier world: robot, field, Toggles, objects and seating |
| `src/sim/` | Match simulation, plan executor (MPC), driver control, scenarios, frames |
| `src/planner/` | World model, path planning, search methods, bounds, robustness, explanations |
| `src/net/` | Team mode: protocol, transports (Supabase Realtime, BroadcastChannel), session |
| `src/workers/` | Optimizer / physics trials and scenario planning in Web Workers |
| `src/ui/` | React UI, Three.js scene and assets, input, charts |
| `tests/` | Vitest suites |
| `scripts/` | Sample report, default plans, CAD converter |

## Known limitations

- Rules and some field dimensions come from secondary sources (see the Rules tab).
  Element shapes beyond the published dimensions are approximations until official
  CAD is loaded.
- Plans are optimal only within the macro-action model and its candidate limits. On
  the full field the optimizer reports best found with a gap, not a proof.
- Physical execution falls short of the model: objects get plowed, wedged or knocked
  over, and other robots interfere. Physics trials quantify the gap.
- Online play depends on Supabase Realtime reachability and quotas. The host's
  device runs the physics for everyone.
