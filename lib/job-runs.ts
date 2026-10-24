import type { SupabaseClient } from '@supabase/supabase-js'

// The table also accepts 'daily-news', kept for when the news briefing returns.
export type JobName = 'ingest'

export type JobRun = {
  job: JobName
  startedAt: number
  httpStatus: number
  assetsOk?: number
  assetsTotal?: number
  errors?: { symbol?: string; error: string }[]
}

// Health recording must never change a job's outcome: a failed write is
// logged, and the dashboard shows the missing run as stale.
export async function recordJobRun(supabase: SupabaseClient, run: JobRun) {
  try {
    const { error } = await supabase.from('job_runs').insert({
      job: run.job,
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      http_status: run.httpStatus,
      ok: run.httpStatus < 400,
      assets_ok: run.assetsOk ?? null,
      assets_total: run.assetsTotal ?? null,
      errors: run.errors ?? [],
    })
    if (error) throw new Error(error.message)
  } catch (error) {
    console.error(`[job-runs ${run.job}]`, error)
  }
}
