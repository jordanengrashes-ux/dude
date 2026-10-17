/**
 * Supabase project used for online team mode (Realtime broadcast + presence only;
 * no tables). The publishable key is meant to ship in client code. Override both
 * with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY at build time.
 */
export const SUPABASE = {
  url: import.meta.env?.VITE_SUPABASE_URL ?? 'https://oayeirqalqxnolxbdlnq.supabase.co',
  key: import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_3Kg51HMqH724EWWhz9kOzw_JYLpTD3A',
};
