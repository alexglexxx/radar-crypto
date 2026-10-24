-- Removes the job health surface. The jobs log and continue when the table
-- is missing, so ingestion keeps working after this rollback.
drop view if exists public.job_health_public;
drop table if exists public.job_runs;
