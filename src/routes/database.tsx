import { formatBytes } from "@/api/backup"
import {
    DATABASE_USAGE_KEY,
    DatabaseCleanupJob,
    DatabaseUsage,
    POLL_FAILURE_LIMIT,
    RETENTION_DEFAULT_DAYS,
    RETENTION_FULL_CHART_DAYS,
    RETENTION_MAX_DAYS,
    RETENTION_MIN_DAYS,
    RETENTION_PRESETS,
    RETENTION_WEEK_CHART_DAYS,
    VacuumMode,
    databaseErrorKind,
    defaultVacuumMode,
    getDatabaseUsage,
    isJobRunning,
    isUnsupportedError,
    jobVacuumMode,
    parseRetentionDays,
    startHistoryCleanup,
    vacuumBlockedByDisk,
} from "@/api/database"
import { RestartOverlay } from "@/components/backup/restart-overlay"
import { SettingsTab } from "@/components/settings-tab"
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/hooks/useAuth"
import { cn } from "@/lib/utils"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, Navigate } from "react-router-dom"
import { toast } from "sonner"
import useSWR, { useSWRConfig } from "swr"

const JOB_POLL_MS = 2000
/** Give up waiting for the dashboard to come back after this long. */
const RESTART_TIMEOUT_MS = 5 * 60 * 1000
const ESTIMATE_DEBOUNCE_MS = 300

type RetentionChoice = (typeof RETENTION_PRESETS)[number] | "custom"

interface CleanupPlan {
    days: number
    mode: VacuumMode
    rows: number
    freeSize: number
    sizeAfter?: number
    onlineSeconds?: number
    restartSeconds?: number
}

const VACUUM_MODES: VacuumMode[] = ["online", "restart", "none"]

function useDebounced<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), ms)
        return () => clearTimeout(timer)
    }, [value, ms])
    return debounced
}

export default function DatabasePage() {
    const { t } = useTranslation()
    const { profile, loading } = useAuth()
    const isAdmin = profile?.role === 0

    // While a cleanup runs, failed polls (e.g. the database briefly locked by
    // VACUUM) never reach SWR: the fetcher keeps the cached state, so SWR stays
    // on its regular refresh instead of error backoff, and the failures are
    // counted here; the page only reports them after several in a row.
    const { cache } = useSWRConfig()
    const failures = useRef(0)
    const [pollFailures, setPollFailures] = useState(0)
    const [pollError, setPollError] = useState<Error | null>(null)
    // started_at of the cleanup whose restart we are waiting for (see below).
    const awaitingRestart = useRef<string | null>(null)
    const usage = useSWR<DatabaseUsage>(
        isAdmin ? DATABASE_USAGE_KEY : null,
        async () => {
            try {
                const next = await getDatabaseUsage()
                failures.current = 0
                setPollFailures(0)
                setPollError(null)
                return next
            } catch (e) {
                // Read SWR's cache, not render state: mutate() starts the
                // revalidation before React re-renders with the POSTed job, and
                // an earlier visit leaves a running job there as well.
                const cur = cache.get(DATABASE_USAGE_KEY)?.data as DatabaseUsage | undefined
                const waiting =
                    !!cur && (isJobRunning(cur.job.state) || awaitingRestart.current !== null)
                if (!cur || !waiting || isUnsupportedError(e)) throw e
                failures.current += 1
                setPollFailures(failures.current)
                setPollError(e as Error)
                return cur
            }
        },
        {
            // Poll only while a cleanup is in flight or its restart is awaited.
            refreshInterval: (data) =>
                isJobRunning(data?.job.state) || awaitingRestart.current !== null ? JOB_POLL_MS : 0,
            shouldRetryOnError: (e) => !isUnsupportedError(e),
        },
    )
    const job = usage.data?.job
    const running = isJobRunning(job?.state)
    const runningMode = job && running ? jobVacuumMode(job) : undefined
    const historyAvailable = !!usage.data?.history_available

    const [choice, setChoice] = useState<RetentionChoice>(RETENTION_DEFAULT_DAYS)
    const [customInput, setCustomInput] = useState("")
    const days = choice === "custom" ? parseRetentionDays(customInput) : choice
    const debouncedDays = useDebounced(days, ESTIMATE_DEBOUNCE_MS)

    // The finish time is part of the key so a finished cleanup refetches the estimate.
    const estimate = useSWR<DatabaseUsage>(
        isAdmin && historyAvailable && debouncedDays !== null && !running
            ? [DATABASE_USAGE_KEY, debouncedDays, job?.finished_at ?? ""]
            : null,
        ([, d]: [string, number]) => getDatabaseUsage(d),
    )
    const settled = debouncedDays === days && !estimate.isLoading
    const est =
        settled && estimate.data?.estimate?.retention_days === days ? estimate.data : undefined

    // null follows the server's recommendation until the user picks a mode.
    const [modeChoice, setModeChoice] = useState<VacuumMode | null>(null)
    const vacuumBlocked = vacuumBlockedByDisk(est)
    const restartAvailable = !!est?.restart_available
    const recommended = defaultVacuumMode(est)
    const modeAllowed = (m: VacuumMode) =>
        m === "none" || (!vacuumBlocked && (m === "online" || restartAvailable))
    const selectedMode: VacuumMode =
        modeChoice && modeAllowed(modeChoice)
            ? modeChoice
            : modeAllowed(recommended)
              ? recommended
              : "none"

    const [plan, setPlan] = useState<CleanupPlan | null>(null)
    const [step, setStep] = useState<"confirm" | "final" | null>(null)
    const [submitting, setSubmitting] = useState(false)

    // Announce a cleanup that finished while this page was watching it, once.
    const announced = useRef("")
    const announce = useCallback(
        (j: DatabaseCleanupJob) => {
            if (j.state !== "succeeded" && j.state !== "failed") return
            const id = `${j.started_at}/${j.state}`
            if (announced.current === id) return
            announced.current = id
            if (j.state === "succeeded") toast.success(t("Database.Cleanup.Finished"))
            else toast.error(t("Database.Cleanup.Failed"), { description: j.error })
        },
        [t],
    )
    const prevState = useRef(job?.state)
    useEffect(() => {
        const prev = prevState.current
        prevState.current = job?.state
        if (job && isJobRunning(prev)) announce(job)
    }, [job, announce])

    // A running cleanup shows the mode it was started with.
    const mode: VacuumMode = runningMode ?? selectedMode

    // The dashboard restarts to compact: wait for it like after a restore. A
    // failed poll right after the deletion also means it already went down.
    // The restart is confirmed once the server reported "restarting"; that state
    // stays cached while the dashboard is down, so the overlay lasts until a poll
    // returns this cleanup's final state. Before that, only several failed polls
    // in a row (a missed "restarting") count, not a brief disconnect. Our own
    // authenticated polling decides when it is over, not an anonymous probe that
    // may still reach the old process.
    //
    // The wait is tied to that cleanup (its started_at, which the result after
    // the restart keeps): a poll that returns no job yet (idle) or another
    // job's result keeps the overlay and the polling going; only a successful
    // poll about this cleanup ends it, with its final state, or with
    // "deleting" when the failed polls were a disconnect after all.
    const suspectedRestart =
        runningMode === "restart" && job?.state === "deleting" && pollFailures >= POLL_FAILURE_LIMIT
    const [pendingRestart, setPendingRestart] = useState<string | null>(null)
    awaitingRestart.current = pendingRestart
    useEffect(() => {
        if (!job) return
        if (pendingRestart === null) {
            if (job.state === "restarting" || suspectedRestart) setPendingRestart(job.started_at)
            return
        }
        if (pollFailures > 0 || job.started_at !== pendingRestart || job.state === "restarting")
            return
        setPendingRestart(null)
        announce(job)
    }, [job, pollFailures, pendingRestart, suspectedRestart, announce])
    const restartActive = pendingRestart !== null || job?.state === "restarting" || suspectedRestart
    const [restartTimedOut, setRestartTimedOut] = useState(false)
    useEffect(() => {
        setRestartTimedOut(false)
        if (!restartActive) return
        const timer = setTimeout(() => setRestartTimedOut(true), RESTART_TIMEOUT_MS)
        return () => clearTimeout(timer)
    }, [restartActive])

    if (loading) return null
    if (!isAdmin) return <Navigate to="/dashboard/settings/api-tokens" replace />

    const data = usage.data
    const deletable = est?.estimate?.deletable_rows ?? 0
    const canClean = !!est?.estimate && deletable > 0 && !running && !submitting

    // Raw codes such as ApiErrorUnauthorized mean nothing to users.
    function errorText(e: unknown): string {
        const kind = databaseErrorKind(e)
        if (kind === "unauthorized") return t("Database.Error.Unauthorized")
        if (kind === "forbidden") return t("Database.Error.Forbidden")
        if (kind === "unavailable") return t("Database.Error.Unavailable")
        return e instanceof Error ? e.message : String(e)
    }

    function duration(seconds: number | undefined): string {
        return seconds && seconds > 0
            ? t("Database.Duration", { seconds })
            : t("Database.DurationUnknown")
    }

    // Older dashboards (and a running cleanup) give no duration: leave it out.
    function withDuration(key: string, seconds: number | undefined): string {
        return seconds && seconds > 0 ? t(key, { duration: duration(seconds) }) : t(`${key}NoTime`)
    }

    function estimateText(): string {
        const e = est!.estimate!
        const vars = {
            rows: deletable.toLocaleString(),
            size: formatBytes(e.estimated_free_size),
            after: e.size_after !== undefined ? formatBytes(e.size_after) : "",
        }
        if (mode === "none") return t("Database.Cleanup.EstimateNoVacuum", vars)
        return e.size_after !== undefined
            ? t("Database.Cleanup.EstimateWithSize", vars)
            : t("Database.Cleanup.Estimate", vars)
    }

    function recommendationText(): string | null {
        const e = est?.estimate
        if (!e?.recommendation_reason || vacuumBlocked) return null
        const vars = {
            online: duration(e.online_vacuum_seconds),
            restart: duration(e.restart_downtime_seconds),
        }
        if (e.recommendation_reason === "short") return t("Database.Mode.ReasonShort", vars)
        if (e.recommendation_reason === "long") return t("Database.Mode.ReasonLong", vars)
        return t("Database.Mode.ReasonRestartUnavailable", vars)
    }

    function pollNotice(): string | null {
        if (!running || !pollError || restartActive) return null
        // An online compaction locks the database: stalls are expected, say so at
        // once. The lock can come before the poll that would report "vacuuming".
        if (runningMode === "online" && job?.state === "vacuuming")
            return t("Database.Cleanup.PollFailedOnline")
        if (runningMode === "online" && job?.state === "deleting")
            return t("Database.Cleanup.PollFailedMaybeVacuuming")
        if (pollFailures < POLL_FAILURE_LIMIT) return null
        return t("Database.Cleanup.PollFailed", { error: errorText(pollError) })
    }

    // Never show a placeholder for the temporary space: say why it is missing.
    function vacuumHint(): string {
        if (est?.estimate) {
            const required = formatBytes(est.estimate.vacuum_required_size)
            if (vacuumBlocked)
                return t("Database.Cleanup.VacuumNoSpace", {
                    required,
                    free: formatBytes(est.disk_free),
                })
            return est.disk_free > 0
                ? t("Database.Cleanup.VacuumHint", { required, free: formatBytes(est.disk_free) })
                : t("Database.Cleanup.VacuumHintNoFree", { required })
        }
        if (running || days === null) return t("Database.Cleanup.VacuumHintBase")
        if (settled && estimate.error) return t("Database.Cleanup.VacuumHintUnknown")
        return t("Database.Cleanup.VacuumHintPending")
    }

    function openConfirm() {
        if (!est?.estimate || days === null) return
        setPlan({
            days,
            mode,
            rows: est.estimate.deletable_rows,
            freeSize: est.estimate.estimated_free_size,
            sizeAfter: est.estimate.size_after,
            onlineSeconds: est.estimate.online_vacuum_seconds,
            restartSeconds: est.estimate.restart_downtime_seconds,
        })
        setStep("confirm")
    }

    async function runCleanup() {
        if (!plan) return
        setSubmitting(true)
        try {
            const started = await startHistoryCleanup(plan.days, plan.mode)
            prevState.current = started.state
            await usage.mutate((cur) => (cur ? { ...cur, job: started } : cur), {
                revalidate: true,
            })
            toast.success(t("Database.Cleanup.Started"))
        } catch (e) {
            toast.error(t("Error"), { description: errorText(e) })
            void usage.mutate()
        } finally {
            setSubmitting(false)
            setStep(null)
        }
    }

    return (
        <div className="px-3 pb-10">
            <SettingsTab className="mt-6 mb-4 w-full" />
            <div className="mb-4">
                <h1 className="text-xl font-semibold">{t("Database.Title")}</h1>
                <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
                    {t("Database.Description")}
                </p>
            </div>

            {pollNotice() && (
                <p className="text-destructive text-sm" role="alert">
                    {pollNotice()}
                </p>
            )}

            {usage.error &&
                (isUnsupportedError(usage.error) ? (
                    <p className="text-muted-foreground text-sm" data-testid="database-unsupported">
                        {t("Database.Unsupported")}
                    </p>
                ) : (
                    <p className="text-destructive text-sm" role="alert">
                        {t("Results.ErrorFetchingResource", { error: errorText(usage.error) })}
                    </p>
                ))}

            {data && (
                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">{t("Database.Usage.Title")}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <dl
                                className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
                                data-testid="database-usage"
                            >
                                <dt className="text-muted-foreground">
                                    {t("Database.Usage.Size")}
                                </dt>
                                <dd>{formatBytes(data.db_size)}</dd>
                                <dt className="text-muted-foreground">
                                    {t("Database.Usage.FreePages")}
                                </dt>
                                <dd>{formatBytes(data.free_pages_size)}</dd>
                                {data.history_available && (
                                    <>
                                        <dt className="text-muted-foreground">
                                            {t("Database.Usage.HistoryRows")}
                                        </dt>
                                        <dd>{data.history_rows.toLocaleString()}</dd>
                                        <dt className="text-muted-foreground">
                                            {t("Database.Usage.OldestRecord")}
                                        </dt>
                                        <dd>
                                            {data.history_oldest_at
                                                ? new Date(data.history_oldest_at).toLocaleString()
                                                : "-"}
                                        </dd>
                                    </>
                                )}
                                <dt className="text-muted-foreground">
                                    {t("Database.Usage.DiskFree")}
                                </dt>
                                <dd>
                                    {data.disk_free > 0
                                        ? formatBytes(data.disk_free)
                                        : t("Database.Unknown")}
                                </dd>
                            </dl>
                            {!data.history_available && (
                                <p
                                    className="text-muted-foreground mt-3 text-sm"
                                    data-testid="database-history-unavailable"
                                >
                                    {t("Database.HistoryUnavailable")}
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    {data.history_available && (
                        <Card data-testid="database-cleanup">
                            <CardHeader>
                                <CardTitle className="text-lg">
                                    {t("Database.Cleanup.Title")}
                                </CardTitle>
                                <CardDescription>
                                    {t("Database.Cleanup.Description")}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <fieldset disabled={running || submitting} className="space-y-2">
                                    <legend className="text-sm font-medium">
                                        {t("Database.Cleanup.Retention")}
                                    </legend>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {[...RETENTION_PRESETS, "custom" as const].map((c) => (
                                            <label
                                                key={c}
                                                className={cn(
                                                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
                                                    choice === c && "border-primary",
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="retention"
                                                    value={String(c)}
                                                    checked={choice === c}
                                                    onChange={() => setChoice(c)}
                                                />
                                                {c === "custom"
                                                    ? t("Database.Cleanup.Custom")
                                                    : t("Database.Cleanup.Days", { days: c })}
                                            </label>
                                        ))}
                                        {choice === "custom" && (
                                            <Input
                                                type="number"
                                                inputMode="numeric"
                                                className="w-32"
                                                min={RETENTION_MIN_DAYS}
                                                max={RETENTION_MAX_DAYS}
                                                step={1}
                                                value={customInput}
                                                onChange={(e) => setCustomInput(e.target.value)}
                                                aria-label={t("Database.Cleanup.CustomDays", {
                                                    min: RETENTION_MIN_DAYS,
                                                    max: RETENTION_MAX_DAYS,
                                                })}
                                                placeholder={t("Database.Cleanup.CustomDays", {
                                                    min: RETENTION_MIN_DAYS,
                                                    max: RETENTION_MAX_DAYS,
                                                })}
                                            />
                                        )}
                                    </div>
                                    {choice === "custom" && customInput !== "" && days === null && (
                                        <p className="text-destructive text-sm" role="alert">
                                            {t("Database.Cleanup.InvalidDays", {
                                                min: RETENTION_MIN_DAYS,
                                                max: RETENTION_MAX_DAYS,
                                            })}
                                        </p>
                                    )}
                                    {days !== null && days < RETENTION_FULL_CHART_DAYS && (
                                        <p
                                            className="text-sm text-amber-600"
                                            data-testid="database-short-retention"
                                        >
                                            {days < RETENTION_WEEK_CHART_DAYS
                                                ? t("Database.Cleanup.ShortRetentionWeek")
                                                : t("Database.Cleanup.ShortRetention")}
                                        </p>
                                    )}
                                </fieldset>

                                {days !== null && !running && (
                                    <p className="text-sm" data-testid="database-estimate">
                                        {!est
                                            ? estimate.error
                                                ? t("Results.ErrorFetchingResource", {
                                                      error: errorText(estimate.error),
                                                  })
                                                : t("Database.Cleanup.Estimating")
                                            : deletable === 0
                                              ? t("Database.Cleanup.NothingToClean")
                                              : estimateText()}
                                        {est?.estimate?.approximate && deletable > 0 && (
                                            <span className="text-muted-foreground ml-1">
                                                {t("Database.Cleanup.Approximate")}
                                            </span>
                                        )}
                                    </p>
                                )}

                                <fieldset
                                    disabled={running || submitting}
                                    className="space-y-2"
                                    data-testid="database-vacuum-mode"
                                >
                                    <legend className="text-sm font-medium">
                                        {t("Database.Mode.Title")}
                                    </legend>
                                    <div className="flex flex-col gap-2">
                                        {VACUUM_MODES.map((m) => (
                                            <label
                                                key={m}
                                                className={cn(
                                                    "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                                                    mode === m && "border-primary",
                                                    modeAllowed(m)
                                                        ? "cursor-pointer"
                                                        : "cursor-not-allowed opacity-60",
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="vacuum-mode"
                                                    className="mt-0.5"
                                                    value={m}
                                                    checked={mode === m}
                                                    disabled={!modeAllowed(m)}
                                                    onChange={() => setModeChoice(m)}
                                                />
                                                <span>
                                                    <span className="font-medium">
                                                        {t(`Database.Mode.${m}`)}
                                                    </span>
                                                    {est?.estimate &&
                                                        est.estimate.recommended_vacuum_mode ===
                                                            m &&
                                                        modeAllowed(m) && (
                                                            <span className="text-primary ml-2 text-xs font-semibold">
                                                                {t("Database.Mode.Recommended")}
                                                            </span>
                                                        )}
                                                    <span className="text-muted-foreground block">
                                                        {m === "online"
                                                            ? withDuration(
                                                                  "Database.Mode.OnlineDetail",
                                                                  est?.estimate
                                                                      ?.online_vacuum_seconds,
                                                              )
                                                            : m === "restart"
                                                              ? est && !restartAvailable
                                                                  ? t(
                                                                        "Database.Mode.RestartUnavailable",
                                                                    )
                                                                  : withDuration(
                                                                        "Database.Mode.RestartDetail",
                                                                        est?.estimate
                                                                            ?.restart_downtime_seconds,
                                                                    )
                                                              : t("Database.Mode.NoneDetail")}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                    {recommendationText() && (
                                        <p
                                            className="text-sm"
                                            data-testid="database-vacuum-recommendation"
                                        >
                                            {recommendationText()}
                                        </p>
                                    )}
                                    <p
                                        className={cn(
                                            "text-sm",
                                            vacuumBlocked
                                                ? "text-destructive"
                                                : "text-muted-foreground",
                                        )}
                                        data-testid="database-vacuum-hint"
                                    >
                                        {vacuumHint()}
                                    </p>
                                </fieldset>

                                <Button
                                    variant="destructive"
                                    disabled={!canClean}
                                    onClick={openConfirm}
                                >
                                    {job?.state === "deleting"
                                        ? t("Database.Cleanup.Deleting")
                                        : job?.state === "vacuuming"
                                          ? t("Database.Cleanup.Vacuuming")
                                          : job?.state === "restarting"
                                            ? t("Database.Cleanup.Restarting")
                                            : t("Database.Cleanup.Run")}
                                </Button>

                                {job && (job.state === "succeeded" || job.state === "failed") && (
                                    <JobResult job={job} />
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}

            <AlertDialog
                open={step !== null}
                onOpenChange={(open) => {
                    if (!open && !submitting) setStep(null)
                }}
            >
                <AlertDialogContent>
                    {plan && step === "confirm" && (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t("Database.Confirm.Title")}</AlertDialogTitle>
                                <AlertDialogDescription asChild>
                                    <ul className="list-disc space-y-1 pl-5">
                                        <li>{t("Database.Cleanup.Days", { days: plan.days })}</li>
                                        <li>
                                            {t(
                                                plan.mode === "none"
                                                    ? "Database.Cleanup.EstimateNoVacuum"
                                                    : plan.sizeAfter !== undefined
                                                      ? "Database.Cleanup.EstimateWithSize"
                                                      : "Database.Cleanup.Estimate",
                                                {
                                                    rows: plan.rows.toLocaleString(),
                                                    size: formatBytes(plan.freeSize),
                                                    after:
                                                        plan.sizeAfter !== undefined
                                                            ? formatBytes(plan.sizeAfter)
                                                            : "",
                                                },
                                            )}
                                        </li>
                                        <li data-testid="database-confirm-mode">
                                            {plan.mode === "online"
                                                ? withDuration(
                                                      "Database.Confirm.ModeOnline",
                                                      plan.onlineSeconds,
                                                  )
                                                : plan.mode === "restart"
                                                  ? withDuration(
                                                        "Database.Confirm.ModeRestart",
                                                        plan.restartSeconds,
                                                    )
                                                  : t("Database.Confirm.ModeNone")}
                                        </li>
                                    </ul>
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                <Button variant="destructive" onClick={() => setStep("final")}>
                                    {t("Database.Confirm.Next")}
                                </Button>
                            </AlertDialogFooter>
                        </>
                    )}
                    {plan && step === "final" && (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    {t("Database.Confirm.FinalTitle")}
                                </AlertDialogTitle>
                                <AlertDialogDescription asChild>
                                    <div className="space-y-2">
                                        <p>{t("Database.Confirm.Irreversible")}</p>
                                        {plan.mode === "online" && (
                                            <p data-testid="database-confirm-impact">
                                                {withDuration(
                                                    "Database.Confirm.OnlineImpact",
                                                    plan.onlineSeconds,
                                                )}
                                            </p>
                                        )}
                                        {plan.mode === "restart" && (
                                            <>
                                                <p data-testid="database-confirm-impact">
                                                    {withDuration(
                                                        "Database.Confirm.RestartImpact",
                                                        plan.restartSeconds,
                                                    )}
                                                </p>
                                                <p>{t("Database.Confirm.RestartRequirement")}</p>
                                            </>
                                        )}
                                        <p>
                                            <Link
                                                to="/dashboard/settings/backup"
                                                className="underline"
                                            >
                                                {t("Database.Confirm.GoBackup")}
                                            </Link>
                                        </p>
                                    </div>
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel disabled={submitting}>
                                    {t("Cancel")}
                                </AlertDialogCancel>
                                <Button
                                    variant="destructive"
                                    disabled={submitting}
                                    onClick={runCleanup}
                                >
                                    {submitting ? t("Loading") + "..." : t("Database.Confirm.Run")}
                                </Button>
                            </AlertDialogFooter>
                        </>
                    )}
                </AlertDialogContent>
            </AlertDialog>
            <RestartOverlay
                active={restartActive}
                watch={false}
                timedOut={restartTimedOut}
                redirectTo="/dashboard/login"
                title={t("Database.Restart.Title")}
                description={t("Database.Restart.Description")}
            />
        </div>
    )
}

function JobResult({ job }: { job: DatabaseCleanupJob }) {
    const { t } = useTranslation()
    const ok = job.state === "succeeded"
    return (
        <div
            role="status"
            data-testid="database-job-result"
            className={cn(
                "rounded border p-3 text-sm",
                ok ? "border-green-600/40" : "border-destructive bg-destructive/10",
            )}
        >
            <p className="font-medium">
                {ok
                    ? t("Database.Result.Succeeded", {
                          rows: job.deleted_rows.toLocaleString(),
                          size: formatBytes(job.freed_size),
                      })
                    : t("Database.Result.Failed", { rows: job.deleted_rows.toLocaleString() })}
            </p>
            {ok && job.vacuum_mode === "restart" && job.vacuum_skipped === "" && (
                <p className="text-muted-foreground mt-1">{t("Database.Result.RestartDone")}</p>
            )}
            {ok && job.vacuum_skipped === "insufficient_disk" && (
                <p className="text-destructive mt-1">{t("Database.Result.VacuumNoSpace")}</p>
            )}
            {ok && job.vacuum_skipped === "not_requested" && (
                <p className="text-muted-foreground mt-1">
                    {t("Database.Result.VacuumNotRequested")}
                </p>
            )}
            {!ok && job.error && <p className="text-destructive mt-1">{job.error}</p>}
            {job.finished_at && (
                <p className="text-muted-foreground mt-1 text-xs">
                    {new Date(job.finished_at).toLocaleString()}
                </p>
            )}
        </div>
    )
}
