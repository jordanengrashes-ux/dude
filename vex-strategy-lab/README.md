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

Everyone who opens the site joins one shared **public game**, in Practice too, so
there is nothing to create. Its first visitor hosts it; whoever comes next replaces
a bot (the host's partner first, then the opponents), gets the 3rd-person camera on
their robot, and the match starts (a host who was practicing is switched to a match
for both of them). When every robot has a driver, a newcomer is asked: **Start a
private game** (a room of your own; the header's **copy invite link**,
`…/?room=CODE`, brings friends in) or **Watch the public game**. If the host leaves,
one of the guests takes over hosting the same room and play goes on (a fresh match).
A private room's link works the same way: whoever opens it joins, and if nobody is
hosting it, the visitor hosts it. Online rooms use Supabase Realtime; if it can't be
reached, the room links tabs of the same browser.

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
inside Supabase's free-plan Realtime rate (100 messages/s); every watching guest
adds to the monthly message count. Keep the host's tab open; if it is hidden, the
match keeps running on timer ticks.

## Controls

Press W A S D on the field to take over your robot (your slot, or the first one a
bot drives); the camera locks behind it in 3rd person. **Click the field to lock the
mouse to it**: moving the mouse then looks around the robot (the camera circles a
point at the back of the robot, keeps that angle and turns with the robot), left click turns the claw on / off, holding the
right button runs the rollers in, and Esc frees the cursor (dragging also looks
around while it is free). Scroll to zoom; zoom all the way in (or press B) and you
are in first person: the robot's eye behind the claw, a wide view with the claw at
the bottom and the field ahead (your own lift towers are hidden so they don't fill
the view). Scroll out or press B to go back. V puts the camera behind the robot
again.

Every action can be rebound: open **Controls** in the Drivers card, click a key or
controller cell and press the new key or button (Esc cancels, Delete clears it).
Each action takes two keys and one controller button; a key or button does one
thing, so binding it moves it off any other action. Bindings are saved in this
browser; **Reset to defaults** brings these back:

| Action | Keyboard / mouse | Controller |
|---|---|---|
| Drive / turn (arcade) | W/S, A/D or arrows | left stick Y / right stick X (split) |
| Arm up / down (DR4B) | Space / Shift (also R / F) | R1 / R2 (R2 analog) |
| Arm presets: floor, Alliance Goal, short Goal, tall Goal | 1 2 3 4 | D-pad ↓ ← → ↑ |
| Rollers in (hold): pull a piece at the jaws in and grip it | E or hold the right mouse button | L2 |
| Rollers out (hold): push the held piece out the front | Q | B |
| Claw on / off: on, it closes and its rollers pull in what reaches the jaws; off, it opens (lets go) | left click or C | L1 |
| Open the claw (drop) | Z | — |
| Look around / zoom (all the way in: first person) | mouse (cursor locked) or drag / mouse wheel | right stick (one-stick layout) |
| First / third person | B | L3 |
| Camera back behind the robot | V | R3 |
| Camera up / down (hold) | I / K (also Page Up / Page Down) | right stick up / down |
| Easy claw on / off | G | Back |
| No momentum on / off | M | A |
| Toggle arm (hold) | T | X |
| Swap pockets (two-pocket holder only) | — | — |
| Flip the held piece (needs a flip mechanism, Robot tab) | X | — |
| Request a Match Load | L | Y |
| Play / pause (host or offline) | P | Start |

Saved bindings from before the rollers keep their keys, except that E and Q (and
the controller defaults) go to the rollers.

Controllers use the standard mapping (Xbox / PlayStation / most USB pads; press a
button once so the browser sees it); buttons are named as on a VEX controller (L1,
R1, L2, R2 are the bumpers and triggers). **Split** sticks: left stick drives,
right stick turns (pushed up / down it tilts the camera). **One stick**: the left stick drives and turns and the right
stick moves the camera. A trigger bound to the arm moves it in proportion to how
far it is pressed.

The Easy claw and No momentum checkboxes in the HUD take clicks (the rest of the
HUD lets clicks through to the field); after a click, the keys drive again.

Turning works at speed: when forward + turn would exceed full power, both sides
scale down together so the turn is kept, and the turn grows with speed (in place it
stays gentle for aiming). **No momentum** (checkbox in the HUD, or M) keeps the
same motors and top speed but takes out the coasting: let go and the robot stops
dead, ease off and it slows at once, push the other way and it stops before
reversing.

**The claw** is a roller claw: two jaws hinged behind the holder, each with a
vertical shaft of three roller wheels at its tip. It is a toggle: turn it **on**
(click, C, L1) and it closes and its rollers keep pulling in — drive up to a piece
and whatever reaches the jaws (within about 1" of the claw's center line, up to 3"
in front) is pulled in and gripped; turn it **off** and it opens and lets go (Z
also turns it off). Holding **intake** (E, the right mouse button, L2) runs the
rollers in without the toggle; **outtake** (Q, B) runs them backward and pushes the
piece out the front. A Pin has to be standing: the rollers take a Pin
tipped up to 20° from upright; one lying down slips out. A Cup lying down is pulled
in as far as it goes and stood up. Pieces nested on the gripped one (a Pin in a
Cup, a Cup on that Pin, …) ride along, so the claw can carry a whole nested stack:
2 Cups + 2 Pins at once. Holding a stack, lower it onto a standing piece it nests
on and run the rollers: they lift the stack and take the new piece in at the
bottom. Holding more than one Pin and one Cup breaks the possession limit in a
match (flagged as `SG (possession)`; Practice has no rule checks).

Everything here is rigid-body physics, not animation. A held piece is part of the
claw: its collision shapes are attached to the lift carriage, so it can't wobble
when the robot brakes, and it pushes (and is stopped by) loose pieces, Goals,
walls and robots. A dropped piece falls, bounces and comes to rest by itself; it
only counts as stacked once it is at rest nested on the stack's top (centered,
upright, at the height where the next element sits). The Goal socket is hollow and
follows the Pin's cone, so a Pin dropped near its axis slides in and sits on its
band; a Pin dropped into a Cup, or a Cup over a Pin, nests the same way, also from
high up (fast pieces predict their contacts, so a thin rim can't sink into what it
lands on). A Pin standing on its 1.4" tip with a Cup dropped on it from a foot up
can be knocked over — as with the real pieces.

The HUD shows the claw (closed / open, and what it holds; the light on the carriage
is green when closed, amber when open) and the **aligner**: a ring on the Goal your
held piece would go on — or on a loose Cup standing on the tiles your Pin would drop
into (a loose Pin, for a held Cup) — with a disc showing how far off center a drop
still goes in and a dot (on a plumb line) where your piece is now. White: the dot
is outside the disc; orange: inside but held too low to clear the rim; green:
opening the claw now drops it in. The disc comes from the shapes: 0.45" for a Pin
into a Goal socket (its 1.4" tip in the 2.41" bore), 0.7" for a Pin into a Cup or a
Cup over a Pin. A pair that comes to rest nested stays together as one piece until
it's picked up or tips over.

**Easy claw** (checkbox in the HUD, or G): the rollers take whatever the robot
drives into — pieces lying on the ground too, which the claw stands up — even with
the claw off, never take a scored piece off a Goal (turn the claw on to), wait 1.5 s
after a drop before taking anything again, and a dropped piece falling within 2.5"
of a Goal (or loose piece) it nests on is steered over it as it falls — it still
falls and lands by physics. It is a per-player setting, like No momentum; a team
host applies each player's choice.

## Practice

The app opens in **Practice**: only your robot on the full Head-to-Head field, no
bots, no time limit, you drive from the first second (no Autonomous wait) and no
rule checks, in 3rd person, with Easy claw and No momentum on (turn them off in the
HUD). The clock starts when you start driving and counts up. **Match** in the header
(or `?mode=match`) brings the bots; an invite link (`?room=`) opens a match. You
are in the public game while you practice (see Team mode).

**Settings are saved** in this browser as you change them: your robot, rule
switches, match type and slot, each robot's strategy, optimizer settings, camera,
view toggles, Practice / Match, plus key bindings, Easy claw and No momentum.
**Reset settings** (Setup tab) goes back to the defaults.

## Plan mode

The **Plan** tab has two boards.

**Autonomous**: build a routine on an overhead field and run it with the same
physics as the match.
- Click on the field to add steps. In *Smart* mode a click on a Goal adds a "place
  on it" sequence (arm up to the Goal, route around Goal posts, Loaders and the Pins
  and Cups on the tiles, line the claw up, open, back away, arm down), a click on a
  Pin or Cup adds "pick it up" (arm down, route, open, drive the claw onto it,
  close), anywhere else a drive. Routes keep the robot off the other pieces (it may
  brush one when there is no other way). *Drive*, *Back up* and *Turn* modes add
  just that; shift-click backs up. In a match autonomous, routes stay on your side
  of the Autonomous Line.
- **Starting position**: drag the robot on the field to move it, its ⟳ handle to
  turn it (15° steps, Shift for any angle), or type x / y / θ. It snaps against a
  wall within 1.5"; the program's `setPose` follows, and a note says if the pose
  breaks SG1 (not touching the wall, over the Autonomous Line, in a Load Zone).
- Edit any step (coordinates, heading, speed, "keep going" = LemLib async), add
  lift / claw / wait / turn / Toggle-arm steps, reorder, delete, drag the numbered
  points on the field. New steps go after the selected one.
- **Run with physics** simulates it on your robot (15 s match autonomous or 60 s
  Skills): the path it actually drove (dashed green), the score, when it finished,
  which motions timed out, what it grabbed and scored, and any rule violations.
  **Watch in 3D** runs it on the Field tab.
- Programs are saved in this browser (Save / Open).

**PROS code**: **Export code** writes the routine as PROS C++ for
[Robot Studio](https://robotstudio.ct839.com/). **Send to Robot Studio** copies it
and opens your project in a new tab: paste it into `src/main.cpp` there. Paste your
project's link (`robotstudio.ct839.com/p/…`) once and Send opens that project
directly; it is remembered in this browser. (Robot Studio only takes requests from
its own site, so the code goes through the clipboard rather than your account.)
Copy and download main.cpp work too. The code is:
- *LemLib*, field-centric: `chassis.setPose` on the starting tile, then
  `moveToPoint` / `turnToHeading` / `turnToPoint` / `moveToPose` in field inches
  (0° = up, clockwise), `waitUntilDone`;
- *EZ-Template*: relative `pid_drive_set` / `pid_turn_set` / `pid_wait`;
- the lift as `lift.move_absolute(motor degrees)` through the robot's DR4B gearing,
  the claw and Toggle arm as pistons; optionally a whole main.cpp with devices,
  chassis setup and a driver control using the same buttons as the simulator.

**Import code** reads a PROS autonomous (LemLib, EZ-Template or plain motor
calls): copy your file in Robot Studio, then **Paste from clipboard** (or paste into
the box). It runs it: helper functions called from `autonomous()` are followed,
constants and units (`24_in`, `90_deg`) evaluated, fixed-count `for` loops
unrolled, LemLib motions queued and asynchronous as on the robot, EZ-Template
motions replacing each other until `pid_wait`. Devices are matched to the robot's
lift, claw, Toggle arm and drive by their names (editable). Anything the simulator
can't predict (if / while on sensors, unknown devices) is listed with its line
number and skipped. Code without `setPose` starts at (0, 0, 0) on the chosen tile.

The simulated motions are this simulator's controllers with LemLib-like behavior
(point at the target, drive in, slow down, exit on arrival or timeout), not your
PID gains, so a routine that works here may still need tuning on the robot.

**Whiteboard**: pen, arrows, notes and robot tokens over the field, several boards
saved in this browser, and **Save picture** for a PNG to send to your team.

## The field

The field follows the Game Manual v1.1 Appendix A drawings: 140.41" inside the
walls (1.27" thick, 11.5" tall), tile seams 23.545" apart; the Midfield is the
diamond inside the tape through the four-tile corners; the Autonomous Line is two
tape strips 2.5" apart from the corners to the Midfield and around it; Loaders
stand on the Alliance Station walls 11.44" from the corners (3.74" deep, Ø3.39"
tube), each in a Load Zone 11.56" × 24.47" marked by colored tape; Goals at the
official spots with rims at 3.25" / 5.77" / 8.77". Pins (Ø3.16" band, Ø2.35"
cones, 6.5") and Cups (Ø3.16" rims, Ø2.32" waist) have the published sizes.

Starting pieces (Head-to-Head, 36 Cups and 33 Pins on the tiles, 5 Pins in Goals):
four crosses on the Autonomous Line (a clear-up Cup with four Pins lying around it,
colored ends out), a red/blue Pin standing in a Cup at each Midfield corner, yellow
Pins in Cups on the diagonal, eight rows of Cup / Pin-in-Cup / Cup against the walls,
and a yellow Pin on each neutral Goal and the Midfield Goal. Robots start one per
Quadrant against their own wall, as in Figure SG-1. The 28 objects on the
Autonomous Line may be used by either alliance in Autonomous (SG7b). Skills uses the
same tiles with empty Goals.

With a claw that takes only standing Pins, the 16 Pins lying in the crosses are out
of reach until something stands them up; the standing Pins all start in Cups, so the
claw picks those up as pairs (gripping the Cup) and stacks both on a Goal topped by
a Pin. A robot's claw can't reach pieces touching a wall (its front would be in the
wall), so the wall rows stay put until pushed out.

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

The bots drive the same robot you do: one piece in the claw, standing Pins only.
When a plan trades the held piece for a different one (say, a Cup it can't place
yet for a Pin), the bot sets it down and backs away first. A Pin standing in a Cup
is picked up with its Cup and stacked as a pair. Bots route around loose Pins and
Cups when there is a way, and their intake runs as they close in, so a Pin they
reach is caught rather than knocked over; a Pin that does tip over stays on the
tiles for good, and Loaders or Goals blocked by such pieces are avoided for a while.
A robot parked early (nothing else looked doable) looks again every few seconds.

## The robot

The default robot is the given 16 × 16 in four-wheel drive with a **double reverse
four-bar (DR4B)** lift; rack and pinion is still selectable in the Robot tab.
Unknowns are labeled as assumptions and editable:
- 8.5 in bars over −25°…50° (20.2 in of travel)
- 2 × 200 rpm lift motors at 1:7
- 3.25 in wheels on 450 rpm
- 15 lb
- a roller claw (two vertical shafts of three roller wheels) that grips one piece
  — pieces nested on it ride along — takes Pins tipped up to 20°, and can't flip a
  piece end-for-end (the two-pocket holder, 1 Pin + 1 Cup, the tilt limit and a
  flip mechanism are settings in the Robot tab)

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
- Pins: 6.5 in, a Ø3.16 in band between two cones (Ø2.35 in narrowing to Ø1.40 in
  tips); Cups: 6.48 in hourglass shells with Ø3.16 in rims and a Ø2.32 in waist.
  Each Pin half nests in a Cup half (band on the rim), so stacks are Pin, Cup, Pin,
  Cup.
- octagonal Goals on element plates, topped by conical sockets (Ø2.37 in) for the
  first Pin
- 25.8 in tri-color Toggle bars on 11.5 in walls; wall Loaders with a clear tube

The physics uses the same shapes: a Pin's collider is its band and two cones (three
convex pieces); a Cup's is a hollow shell (8 wedges per half plus the middle web), so
a Pin dropped into a loose Cup nests and a Cup on its side rolls on its rims. Pieces
are 72 g / 77 g with plastic-on-foam friction and little bounce. The robot's
collision blocks are the parts the 3D model draws: the drive modules from the claw
slot out to the sides (as tall as the wheels), the cross member and deck behind the
slot, the lift towers, the claw carriage and the Toggle arm.

The official STEP files can replace any of them: `docs/CAD.md` covers
`npm run cad`, the converter self-test and `public/models/manifest.json`.

## Project map

| Path | What |
|---|---|
| `src/rules/` | Override rules, scoring with explanations, timing, inspection, sources |
| `src/field/` | Field geometry and object layout |
| `src/robot/` | Robot config, motors, kinematics, lift transmission |
| `src/physics/` | Rapier world: robot, field (hollow Goal sockets), Toggles, pieces held / dropped / stacked |
| `src/sim/` | Match simulation, plan executor (MPC), driver control, scenarios, frames |
| `src/planner/` | World model, path planning, search methods, bounds, robustness, explanations |
| `src/net/` | Team mode: protocol, transports (Supabase Realtime, BroadcastChannel), session |
| `src/workers/` | Optimizer / physics trials and scenario planning in Web Workers |
| `src/ui/` | React UI, Three.js scene and assets, input, charts |
| `tests/` | Vitest suites |
| `scripts/` | Sample report, default plans, CAD converter |

## Known limitations

- Rules come partly from secondary sources (see the Rules tab). The field layout and
  dimensions are from the Game Manual v1.1 PDF (the copy that could be downloaded;
  VEX marks it superseded), so re-check them against the current manual. Element
  shapes beyond the published dimensions are approximations until official CAD is
  loaded.
- Plans are optimal only within the macro-action model and its candidate limits. On
  the full field the optimizer reports best found with a gap, not a proof.
- Physical execution falls short of the model: objects get plowed, wedged or knocked
  over, and other robots interfere. Physics trials quantify the gap. The bots don't
  clear tipped-over pieces: Pins they knock over pile up near walls, Goals and
  Loaders, and the bots work around them.
- Online play depends on Supabase Realtime reachability and quotas. The host's
  device runs the physics for everyone.
