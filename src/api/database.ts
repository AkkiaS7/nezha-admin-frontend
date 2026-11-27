import { FetcherError, FetcherMethod, fetcher } from "./api"

// Types mirror the dashboard swagger (controller/database.go).

export type DatabaseJobState = "idle" | "deleting" | "vacuuming" | "succeeded" | "failed"

/** Why the VACUUM after a cleanup did not run; "" when it ran. */
export type VacuumSkipped = "" | "not_requested" | "insufficient_disk"

export interface DatabaseCleanupJob {
    state: DatabaseJobState
    retention_days: number
    vacuum: boolean
    deleted_rows: number
    freed_size: number
    vacuum_skipped: VacuumSkipped
    /** RFC3339, "" before the first job. */
    started_at: string
    finished_at: string
    error: string
}

export interface HistoryCleanupEstimate {
    retention_days: number
    deletable_rows: number
    estimated_free_size: number
    /** Temporary disk space the VACUUM after the cleanup needs. */
    vacuum_required_size: number
    /** The row count timed out and was approximated from the id range. */
    approximate: boolean
}

export interface DatabaseUsage {
    db_size: number
    free_pages_size: number
    /** Free space on the database's file system; 0 when unknown. */
    disk_free: number
    /** False with TSDB enabled or without the table: only the size is shown. */
    history_available: boolean
    history_rows: number
    /** RFC3339, "" without history. */
    history_oldest_at: string
    /** Present only when retention_days was passed. */
    estimate?: HistoryCleanupEstimate
    job: DatabaseCleanupJob
}

export interface HistoryCleanupRequest {
    retention_days: number
    vacuum: boolean
}

export const DATABASE_USAGE_KEY = "/api/v1/database/usage"
export const HISTORY_CLEANUP_PATH = "/api/v1/database/history-cleanup"

export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 3650
export const RETENTION_DEFAULT_DAYS = 30
export const RETENTION_PRESETS = [30, 90, 180] as const
/** Below this the 7- and 30-day charts lose data; the 30-day status bar does not. */
export const RETENTION_FULL_CHART_DAYS = 30

export const getDatabaseUsage = (retentionDays?: number) =>
    fetcher<DatabaseUsage>(
        FetcherMethod.GET,
        DATABASE_USAGE_KEY,
        retentionDays === undefined ? null : { retention_days: retentionDays },
    )

export const startHistoryCleanup = (data: HistoryCleanupRequest) =>
    fetcher<DatabaseCleanupJob>(FetcherMethod.POST, HISTORY_CLEANUP_PATH, data)

export function isJobRunning(state: DatabaseJobState | undefined): boolean {
    return state === "deleting" || state === "vacuuming"
}

/** Dashboards older than this feature answer the usage request with 404. */
export function isUnsupportedError(e: unknown): boolean {
    return e instanceof FetcherError && e.status === 404
}

/** Parses the custom retention input; null unless it is an integer in range. */
export function parseRetentionDays(input: string): number | null {
    const v = input.trim()
    if (!/^\d+$/.test(v)) return null
    const n = Number(v)
    if (n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) return null
    return n
}

/** VACUUM needs a temporary copy; block it only when the free space is known to be short. */
export function vacuumBlockedByDisk(usage: DatabaseUsage | undefined): boolean {
    if (!usage?.estimate || usage.disk_free <= 0) return false
    return usage.estimate.vacuum_required_size > usage.disk_free
}
