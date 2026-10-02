-- Radar Crypto — remove legacy broad public-read policies left by earlier migrations.

drop policy if exists "public read dashboard signal fields" on public.radar_signals;
drop policy if exists "news_briefings_public_read" on public.news_briefings;
drop policy if exists "news_items_public_read" on public.news_items;
