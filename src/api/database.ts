import { FetcherError, FetcherMethod, fetcher } from "./api"

// Types mirror the dashboard swagger (controller/database.go).

export type DatabaseJobState =
    | "idle"
    | "deleting"
    | "vacuuming"
    /** Rows deleted; the dashboard restarts and compacts the database while starting. */
    | "restarting"
    | "succeeded"
    | "failed"

/** No compaction, compaction right away, or compaction while the dashboard restarts. */
export type VacuumMode = "none" | "online" | "restart"

/** Why the server recommends a mode (a stable code, translated by the client). */
export type RecommendationReason = "short" | "long" | "restart_unavailable"

/** Why the VACUUM after a cleanup did not run; "" when it ran. */
export type VacuumSkipped = "" | "not_requested" | "insufficient_disk"

export interface DatabaseCleanupJob {
    state: DatabaseJobState
    retention_days: number
    vacuum: boolean
    /** Missing on dashboards before the compaction choice: derive it from vacuum. */
    vacuum_mode?: VacuumMode
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
    // The fields below are missing on dashboards before the compaction choice.
    /** Expected database size after the cleanup and a compaction. */
    size_after?: number
    /** Expected duration of an online compaction, i.e. how long the dashboard stalls. */
    online_vacuum_seconds?: number
    /** Expected downtime when compacting during a restart. */
    restart_downtime_seconds?: number
    recommended_vacuum_mode?: Exclude<VacuumMode, "none">
    recommendation_reason?: RecommendationReason
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
    /** The dashboard can restart itself (restart entry set, under systemd or in a container). */
    restart_available?: boolean
    /** Present only when retention_days was passed. */
    estimate?: HistoryCleanupEstimate
    job: DatabaseCleanupJob
}

export interface HistoryCleanupRequest {
    retention_days: number
    vacuum_mode: VacuumMode
    /** For dashboards before vacuum_mode; newer ones prefer vacuum_mode. */
    vacuum: boolean
}

export const DATABASE_USAGE_KEY = "/api/v1/database/usage"
export const HISTORY_CLEANUP_PATH = "/api/v1/database/history-cleanup"

export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 3650
export const RETENTION_DEFAULT_DAYS = 30
export const RETENTION_PRESETS = [30, 90, 180] as const
/** Below this the 30-day charts lose data; the 30-day status bar does not. */
export const RETENTION_FULL_CHART_DAYS = 30
/** Below this the 7-day charts lose data as well. */
export const RETENTION_WEEK_CHART_DAYS = 7

/** Consecutive failed polls of a running cleanup before the page shows the error. */
export const POLL_FAILURE_LIMIT = 3

export const getDatabaseUsage = (retentionDays?: number) =>
    fetcher<DatabaseUsage>(
        FetcherMethod.GET,
        DATABASE_USAGE_KEY,
        retentionDays === undefined ? null : { retention_days: retentionDays },
    )

export const startHistoryCleanup = (retentionDays: number, mode: VacuumMode) =>
    fetcher<DatabaseCleanupJob>(FetcherMethod.POST, HISTORY_CLEANUP_PATH, {
        retention_days: retentionDays,
        vacuum_mode: mode,
        // An older dashboard ignores vacuum_mode; it never offers "restart".
        vacuum: mode !== "none",
    } satisfies HistoryCleanupRequest)

export function isJobRunning(state: DatabaseJobState | undefined): boolean {
    return state === "deleting" || state === "vacuuming" || state === "restarting"
}

export function jobVacuumMode(job: DatabaseCleanupJob): VacuumMode {
    return job.vacuum_mode ?? (job.vacuum ? "online" : "none")
}

/**
 * The mode to preselect: the server's recommendation, restart only when the
 * dashboard can restart itself, nothing when the disk is too small to compact.
 */
export function defaultVacuumMode(usage: DatabaseUsage | undefined): VacuumMode {
    if (vacuumBlockedByDisk(usage)) return "none"
    if (usage?.estimate?.recommended_vacuum_mode === "restart" && usage.restart_available)
        return "restart"
    return "online"
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

/** Which friendly text replaces a raw error, or null to show the server's message. */
export type DatabaseErrorKind = "unauthorized" | "forbidden" | "unavailable"

// The server marks auth failures with fixed, untranslated codes (see useAuth);
// gateways answer 502-504 while the dashboard restarts or is busy.
export function databaseErrorKind(e: unknown): DatabaseErrorKind | null {
    const message = e instanceof Error ? e.message : String(e ?? "")
    if (message.startsWith("ApiErrorUnauthorized") || message === "Unauthorized")
        return "unauthorized"
    if (message.startsWith("ApiErrorForbidden")) return "forbidden"
    if (e instanceof FetcherError && e.status >= 502 && e.status <= 504) return "unavailable"
    if (e instanceof TypeError) return "unavailable" // fetch() network failure
    return null
}
