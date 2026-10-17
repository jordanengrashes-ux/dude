// Supabase Edge Function entry point. All logic lives in handler.ts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { createHandler, postgresTakeToken, secretKeyFromEnv } from "./handler.ts";

const env = (name: string) => Deno.env.get(name);

Deno.serve(
  createHandler({
    env,
    takeToken: (bucket, limit, windowSeconds) =>
      postgresTakeToken(env("SUPABASE_URL")!, secretKeyFromEnv(env))(bucket, limit, windowSeconds),
    anthropic: (apiKey) => new Anthropic({ apiKey }),
  }),
);
