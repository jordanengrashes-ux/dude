# V5 Unit 2 Code Library

Every code snippet from VEX V5 Foundation Unit 2 on one page, with code search and an **Ask AI** chat
that answers "where is…", "how do I…" and "can you help me with…" from the snippets.

- `index.html` is the whole website. Open it in a browser, or host it anywhere static.
- `supabase/` is the Ask AI backend: one Edge Function plus one database table for rate limits.

## Where answers come from

| Where the page runs | Who answers |
|---|---|
| Inside claude.ai (the published artifact) | Claude, through the viewer's own Claude account |
| On your website (GitHub Pages, Vercel, …) | Claude, through the Supabase Edge Function `ask-ai` and your Claude API key |
| Anywhere Ask AI is unavailable | The offline helper, which matches your words to snippets |

The page reads the function address from this tag in `index.html`:

```html
<meta name="ask-ai-endpoint" content="https://oayeirqalqxnolxbdlnq.supabase.co/functions/v1/ask-ai">
```

## Already deployed

- Supabase project `oayeirqalqxnolxbdlnq`: the `ask_ai_usage` table and `ask_ai_take()` function from
  `supabase/migrations/`, and the `ask-ai` Edge Function (JWT check off; it protects itself).

## Still to do (once)

1. **Add your Claude API key.** Create a key at <https://console.anthropic.com>, then add it as the
   secret `ANTHROPIC_API_KEY` at
   <https://supabase.com/dashboard/project/oayeirqalqxnolxbdlnq/functions/secrets>.
   It takes effect immediately; no redeploy. Set a monthly spend limit in the Anthropic console too.
2. **Turn on GitHub Pages.** In the repo, Settings → Pages → Build and deployment → Source:
   "Deploy from a branch", pick the branch that has this folder and `/ (root)`, then Save.
   The library is then at <https://jordanengrashes-ux.github.io/dude/vex-code-library/>.

## How the backend protects your key

- **Fixed instructions.** The page sends its built-in instructions with each question. The function
  only accepts them if their SHA-256 fingerprint is approved, so nobody can use your key for other prompts.
- **Allowed websites.** Only `https://jordanengrashes-ux.github.io` by default.
- **Rate limits.** 30 questions per visitor per hour and 200 in total per day, counted in Postgres
  before anything is spent. If the counter is unreachable the function refuses rather than spend.
- **Size limits.** At most 12 chat turns, 2000 characters per question.
- **Model.** Claude Opus 5.5 at low effort, with server-side refusal fallback. The instructions are
  prompt-cached, so repeat questions within five minutes pay about a tenth for them.

## Settings (Supabase Edge Function secrets, all optional)

| Secret | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://jordanengrashes-ux.github.io` | Comma-separated websites allowed to call Ask AI. `*` allows any. |
| `RATE_PER_VISITOR_PER_HOUR` | `30` | Questions one visitor can ask per hour. |
| `RATE_TOTAL_PER_DAY` | `200` | Questions everyone together can ask per day. This caps your daily cost. |
| `PROMPT_SHA256` | built in | Approved instruction fingerprints, comma-separated. See below. |
| `RATE_SALT` | built in | Mixed into the hashed visitor address. |

## When you change the snippets or the AI rules

The instructions' fingerprint changes, and the website falls back to the offline helper until you
approve the new one:

1. Get the new fingerprint: `node vex-code-library/scripts/prompt-hash.mjs` (needs `npm i -D playwright`),
   or read the `instructions not approved` line in the function's logs.
2. Set it as the `PROMPT_SHA256` secret (no redeploy), or update `DEFAULT_PROMPT_SHA256` in
   `supabase/functions/ask-ai/handler.ts` and redeploy.

## Deploying with the Supabase CLI instead

```bash
cd vex-code-library
supabase link --project-ref oayeirqalqxnolxbdlnq
supabase db push
supabase functions deploy ask-ai
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

## Tests

```bash
cd vex-code-library/supabase/functions/ask-ai
deno test --allow-net --allow-env handler_test.ts
```

The tests run the real Anthropic SDK against a local fake of the Claude API, so they cost nothing.
