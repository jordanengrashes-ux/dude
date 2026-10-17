# V5 Unit 2 Code Library

Every code snippet from VEX V5 Foundation Unit 2 on one page, with code search and an **Ask AI**
helper that is built into the page itself. It needs no account, no API key and no server.

Open `index.html` in any browser, or host it on any static site such as GitHub Pages.

## What the helper can do

- **Find code.** "Where is the code to reverse a motor?" gives the lesson, the section, the file to
  edit and the code, with a button that jumps to the snippet.
- **Explain.** "How does the steer floor work?" or "why must initialize stay short?"
- **Fix problems.** "My push test reads 2115", "the robot sat still in autonomous",
  "the robot creeps when the sticks are centred".
- **Write routines.** "Write a routine called red left that drives 2 tiles, turns right, waits
  1 second and comes back" gives a complete `src/autons/red_left.cpp`, the two registration
  lines, and the expected position after every leg. It understands distances in inches, tiles and
  feet, left and right turns, headings, coordinates, `facing`, waits, and running the intake while
  driving. Follow up with "also turn left 45" to add steps.
- **Know its limits.** It says so when something isn't in the library, like tank drive code,
  button toggles or a flywheel, and points to the closest pattern that is.

## How it works

Everything is plain JavaScript in the last `<script>` of `index.html`:

- `FACTS` is a hand-written knowledge base from lessons 1 to 4. Each fact has example questions,
  keywords, an answer and the snippets it should show.
- `think()` decides what kind of question it is (where, how, why, something is wrong, write a
  routine, small talk), ranks the facts, snippets and lesson notes with a BM25-style search plus
  synonyms students use, and composes the answer.
- `parseRoutine()` and `writeRoutine()` turn described steps into CT Nav calls and track the
  robot's pose on the field (0° is straight ahead, clockwise is positive).

To teach it something new, add an entry to `FACTS`.

## Hosting on GitHub Pages

Settings → Pages → Build and deployment → Source: **Deploy from a branch**. Pick the branch that has
this folder and `/ (root)`, then Save. After a minute or two the library is at
`https://<your-user>.github.io/<repo>/vex-code-library/`.
