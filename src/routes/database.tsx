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
    databaseErrorKind,
    getDatabaseUsage,
    isJobRunning,
    isUnsupportedError,
    parseRetentionDays,
    startHistoryCleanup,
    vacuumBlockedByDisk,
} from "@/api/database"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/hooks/useAuth"
import { cn } from "@/lib/utils"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, Navigate } from "react-router-dom"
import { toast } from "sonner"
import useSWR, { useSWRConfig } from "swr"

const JOB_POLL_MS = 2000
const ESTIMATE_DEBOUNCE_MS = 300

type RetentionChoice = (typeof RETENTION_PRESETS)[number] | "custom"

interface CleanupPlan {
    days: number
    vacuum: boolean
    rows: number
    freeSize: number
}

/** The space is only given back by VACUUM; without it only the rows are deleted. */
function estimateKey(vacuum: boolean): string {
    return vacuum ? "Database.Cleanup.Estimate" : "Database.Cleanup.EstimateNoVacuum"
}

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
    const [pollError, setPollError] = useState<Error | null>(null)
    const usage = useSWR<DatabaseUsage>(
        isAdmin ? DATABASE_USAGE_KEY : null,
        async () => {
            try {
                const next = await getDatabaseUsage()
                failures.current = 0
                setPollError(null)
                return next
            } catch (e) {
                // Read SWR's cache, not render state: mutate() starts the
                // revalidation before React re-renders with the POSTed job, and
                // an earlier visit leaves a running job there as well.
                const cur = cache.get(DATABASE_USAGE_KEY)?.data as DatabaseUsage | undefined
                if (!cur || !isJobRunning(cur.job.state) || isUnsupportedError(e)) throw e
                failures.current += 1
                if (failures.current >= POLL_FAILURE_LIMIT) setPollError(e as Error)
                return cur
            }
        },
        {
            // Poll only while a cleanup is in flight.
            refreshInterval: (data) => (isJobRunning(data?.job.state) ? JOB_POLL_MS : 0),
            shouldRetryOnError: (e) => !isUnsupportedError(e),
        },
    )
    const job = usage.data?.job
    const running = isJobRunning(job?.state)
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

    const [vacuum, setVacuum] = useState(true)
    const vacuumBlocked = vacuumBlockedByDisk(est)
    const vacuumEffective = vacuum && !vacuumBlocked

    const [plan, setPlan] = useState<CleanupPlan | null>(null)
    const [step, setStep] = useState<"confirm" | "final" | null>(null)
    const [submitting, setSubmitting] = useState(false)

    // Announce a cleanup that finished while this page was watching it.
    const prevState = useRef(job?.state)
    useEffect(() => {
        const prev = prevState.current
        prevState.current = job?.state
        if (!job || !isJobRunning(prev)) return
        if (job.state === "succeeded") toast.success(t("Database.Cleanup.Finished"))
        else if (job.state === "failed")
            toast.error(t("Database.Cleanup.Failed"), { description: job.error })
    }, [job, t])

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
            vacuum: vacuumEffective,
            rows: est.estimate.deletable_rows,
            freeSize: est.estimate.estimated_free_size,
        })
        setStep("confirm")
    }

    async function runCleanup() {
        if (!plan) return
        setSubmitting(true)
        try {
            const started = await startHistoryCleanup({
                retention_days: plan.days,
                vacuum: plan.vacuum,
            })
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

            {running && pollError && (
                <p className="text-destructive text-sm" role="alert">
                    {t("Database.Cleanup.PollFailed", { error: errorText(pollError) })}
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
                                              : t(estimateKey(vacuumEffective), {
                                                    rows: deletable.toLocaleString(),
                                                    size: formatBytes(
                                                        est.estimate!.estimated_free_size,
                                                    ),
                                                })}
                                        {est?.estimate?.approximate && deletable > 0 && (
                                            <span className="text-muted-foreground ml-1">
                                                {t("Database.Cleanup.Approximate")}
                                            </span>
                                        )}
                                    </p>
                                )}

                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="database-vacuum"
                                            checked={vacuumEffective}
                                            disabled={vacuumBlocked || running || submitting}
                                            onCheckedChange={(v) => setVacuum(v === true)}
                                        />
                                        <Label htmlFor="database-vacuum">
                                            {t("Database.Cleanup.Vacuum")}
                                        </Label>
                                    </div>
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
                                </div>

                                <Button
                                    variant="destructive"
                                    disabled={!canClean}
                                    onClick={openConfirm}
                                >
                                    {job?.state === "deleting"
                                        ? t("Database.Cleanup.Deleting")
                                        : job?.state === "vacuuming"
                                          ? t("Database.Cleanup.Vacuuming")
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
                                            {t(estimateKey(plan.vacuum), {
                                                rows: plan.rows.toLocaleString(),
                                                size: formatBytes(plan.freeSize),
                                            })}
                                        </li>
                                        <li>
                                            {plan.vacuum
                                                ? t("Database.Confirm.WithVacuum")
                                                : t("Database.Confirm.WithoutVacuum")}
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
                                        {plan.vacuum && <p>{t("Database.Confirm.VacuumLock")}</p>}
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
