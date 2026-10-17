-- Rate-limit counters for the Ask AI Edge Function.
-- Only the Edge Function (using the project's secret key) can read or change them.

create table if not exists public.ask_ai_usage (
  bucket       text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket, window_start)
);

create index if not exists ask_ai_usage_window_start_idx on public.ask_ai_usage (window_start);

alter table public.ask_ai_usage enable row level security;
-- No policies on purpose: anon and signed-in users get nothing.
revoke all on table public.ask_ai_usage from anon, authenticated;

-- Adds one use to a bucket's current window and reports whether it is still within the limit.
create or replace function public.ask_ai_take(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  w timestamptz;
  c integer;
begin
  if p_bucket is null or length(p_bucket) = 0 or length(p_bucket) > 100
     or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 604800 then
    raise exception 'ask_ai_take: invalid arguments';
  end if;

  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.ask_ai_usage as u (bucket, window_start, count)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set count = u.count + 1
  returning u.count into c;

  -- Occasional cleanup of windows older than a week.
  if random() < 0.02 then
    delete from public.ask_ai_usage where window_start < now() - interval '7 days';
  end if;

  return c <= p_limit;
end;
$$;

revoke all on function public.ask_ai_take(text, integer, integer) from public, anon, authenticated;
grant execute on function public.ask_ai_take(text, integer, integer) to service_role;
