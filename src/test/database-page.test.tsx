import { FetcherError } from "@/api/api"
import type { DatabaseCleanupJob, DatabaseUsage } from "@/api/database"
import DatabasePage from "@/routes/database"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    auth: { profile: { role: 0 } as { role: number } | undefined, loading: false },
    swr: vi.fn(),
    start: vi.fn(),
    get: vi.fn(),
    cache: new Map<string, { data?: unknown }>(),
    success: vi.fn(),
    error: vi.fn(),
}))

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mocks.auth }))
vi.mock("@/components/settings-tab", () => ({ SettingsTab: () => null }))
vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key} ${JSON.stringify(opts)}` : key,
    }),
    initReactI18next: { type: "3rdParty", init: () => undefined },
}))
vi.mock("sonner", () => ({
    toast: Object.assign(vi.fn(), { success: mocks.success, error: mocks.error }),
}))
vi.mock("swr", () => ({ default: mocks.swr, useSWRConfig: () => ({ cache: mocks.cache }) }))
vi.mock("@/api/database", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/api/database")>()),
    startHistoryCleanup: mocks.start,
    getDatabaseUsage: mocks.get,
}))

function makeJob(over: Partial<DatabaseCleanupJob> = {}): DatabaseCleanupJob {
    return {
        state: "idle",
        retention_days: 0,
        vacuum: false,
        deleted_rows: 0,
        freed_size: 0,
        vacuum_skipped: "",
        started_at: "",
        finished_at: "",
        error: "",
        ...over,
    }
}

function makeUsage(over: Partial<DatabaseUsage> = {}): DatabaseUsage {
    return {
        db_size: 300 * 1024 * 1024,
        free_pages_size: 28672,
        disk_free: 8 * 1024 * 1024 * 1024,
        history_available: true,
        history_rows: 1_200_000,
        history_oldest_at: "2026-04-25T00:00:00Z",
        job: makeJob(),
        ...over,
    }
}

let usage: { data?: DatabaseUsage; error?: Error }
let deletableRows: (days: number) => number
let diskFree: number
let restartAvailable: boolean | undefined
let estimateExtra: Record<string, unknown>
let vacuumRecommended: boolean | undefined
const usageMutate = vi.fn()

beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth = { profile: { role: 0 }, loading: false }
    usage = { data: makeUsage() }
    deletableRows = (days) => (days >= 180 ? 0 : Math.round(900_000 / days) * 30)
    diskFree = 8 * 1024 * 1024 * 1024
    restartAvailable = undefined
    estimateExtra = {}
    vacuumRecommended = undefined
    mocks.swr.mockImplementation((key: unknown) => {
        if (key === "/api/v1/database/usage")
            return { ...usage, mutate: usageMutate, isLoading: false }
        if (Array.isArray(key)) {
            const days = key[1] as number
            const rows = deletableRows(days)
            return {
                data: makeUsage({
                    disk_free: diskFree,
                    restart_available: restartAvailable,
                    vacuum_recommended: vacuumRecommended,
                    estimate: {
                        ...estimateExtra,
                        retention_days: days,
                        deletable_rows: rows,
                        estimated_free_size: rows * 230,
                        vacuum_required_size: 400 * 1024 * 1024,
                        approximate: false,
                    },
                }),
                isLoading: false,
            }
        }
        return { data: undefined, isLoading: false }
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function renderPage() {
    return render(
        <MemoryRouter>
            <DatabasePage />
        </MemoryRouter>,
    )
}

function estimateKeys(): unknown[][] {
    return mocks.swr.mock.calls.map((c) => c[0]).filter((k): k is unknown[] => Array.isArray(k))
}

test("members never fetch database data", () => {
    mocks.auth = { profile: { role: 1 }, loading: false }
    renderPage()
    expect(screen.queryByText("Database.Title")).toBeNull()
    for (const call of mocks.swr.mock.calls) expect(call[0]).toBeNull()
})

test("an older dashboard without the endpoint shows the unsupported notice", () => {
    usage = { error: new FetcherError("404 Not Found", 404) }
    renderPage()
    expect(screen.getByTestId("database-unsupported")).toBeTruthy()
    expect(screen.queryByTestId("database-cleanup")).toBeNull()
})

test("other errors are reported as fetch errors", () => {
    usage = { error: new FetcherError("boom", 500) }
    renderPage()
    expect(screen.queryByTestId("database-unsupported")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("boom")
})

test("without SQLite history only the usage is shown and no estimate is requested", () => {
    usage = { data: makeUsage({ history_available: false, history_rows: 0 }) }
    renderPage()
    expect(screen.getByTestId("database-usage")).toBeTruthy()
    expect(screen.getByTestId("database-history-unavailable")).toBeTruthy()
    expect(screen.queryByTestId("database-cleanup")).toBeNull()
    expect(estimateKeys().every((k) => k === null)).toBe(true)
})

test("30 days is the default and the cleanup runs only after two confirmations", async () => {
    mocks.start.mockResolvedValue(makeJob({ state: "deleting", retention_days: 30, vacuum: true }))
    renderPage()
    expect((screen.getByDisplayValue("30") as HTMLInputElement).checked).toBe(true)
    expect(estimateKeys().some((k) => k[1] === 30)).toBe(true)
    expect(screen.getByTestId("database-estimate").textContent).toContain(
        'Database.Cleanup.Estimate {"rows":"900,000"',
    )

    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.Title")).toBeTruthy()
    expect(screen.getByTestId("database-confirm-mode").textContent).toContain(
        "Database.Confirm.ModeOnline",
    )
    expect(screen.getByRole("alertdialog").textContent).toContain("Database.Cleanup.Estimate {")
    expect(mocks.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.getByText("Database.Confirm.FinalTitle")).toBeTruthy()
    expect(screen.getByTestId("database-confirm-impact").textContent).toContain(
        "Database.Confirm.OnlineImpact",
    )
    expect(screen.getByText("Database.Confirm.GoBackup").getAttribute("href")).toBe(
        "/dashboard/settings/backup",
    )
    expect(mocks.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(30, "online"))
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Database.Cleanup.Started"))
    expect(usageMutate).toHaveBeenCalled()
})

test("cancelling the second confirmation does not clean up", () => {
    renderPage()
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Cancel"))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(screen.queryByText("Database.Confirm.FinalTitle")).toBeNull()
})

test("choosing no compaction deletes only", async () => {
    mocks.start.mockResolvedValue(makeJob({ state: "deleting" }))
    renderPage()
    fireEvent.click(screen.getByDisplayValue("none"))
    fireEvent.click(screen.getByDisplayValue("90"))
    await waitFor(() => expect(estimateKeys().some((k) => k[1] === 90)).toBe(true))
    await waitFor(() => expect(screen.getByText("Database.Cleanup.Run")).toBeTruthy())
    // without VACUUM the space is only freed by a later compaction
    expect(screen.getByTestId("database-estimate").textContent).toContain(
        "Database.Cleanup.EstimateNoVacuum",
    )
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.ModeNone")).toBeTruthy()
    expect(screen.getByRole("alertdialog").textContent).toContain(
        "Database.Cleanup.EstimateNoVacuum",
    )
    expect(screen.getByRole("alertdialog").textContent).not.toContain("Database.Cleanup.Estimate {")
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.queryByTestId("database-confirm-impact")).toBeNull()
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(90, "none"))
})

test("custom days below 30 warn about the charts; invalid input disables the cleanup", async () => {
    renderPage()
    fireEvent.click(screen.getByDisplayValue("custom"))
    const input = screen.getByRole("spinbutton")

    fireEvent.change(input, { target: { value: "7" } })
    // 7-29 days: only the 30-day charts lose data
    expect(screen.getByTestId("database-short-retention").textContent).toBe(
        "Database.Cleanup.ShortRetention",
    )
    fireEvent.change(input, { target: { value: "29" } })
    expect(screen.getByTestId("database-short-retention").textContent).toBe(
        "Database.Cleanup.ShortRetention",
    )
    fireEvent.change(input, { target: { value: "6" } })
    expect(screen.getByTestId("database-short-retention").textContent).toBe(
        "Database.Cleanup.ShortRetentionWeek",
    )
    fireEvent.change(input, { target: { value: "30" } })
    expect(screen.queryByTestId("database-short-retention")).toBeNull()
    fireEvent.change(input, { target: { value: "7" } })
    await waitFor(() => expect(estimateKeys().some((k) => k[1] === 7)).toBe(true))

    fireEvent.change(input, { target: { value: "0" } })
    expect(screen.queryByTestId("database-short-retention")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("Database.Cleanup.InvalidDays")
    expect((screen.getByText("Database.Cleanup.Run") as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: "3651" } })
    expect((screen.getByText("Database.Cleanup.Run") as HTMLButtonElement).disabled).toBe(true)
    expect(estimateKeys().some((k) => k[1] === 0 || k[1] === 3651)).toBe(false)
})

test("nothing to clean disables the button", async () => {
    renderPage()
    fireEvent.click(screen.getByDisplayValue("180"))
    await waitFor(() =>
        expect(screen.getByTestId("database-estimate").textContent).toContain(
            "Database.Cleanup.NothingToClean",
        ),
    )
    expect((screen.getByText("Database.Cleanup.Run") as HTMLButtonElement).disabled).toBe(true)
})

test("insufficient disk space disables VACUUM and the cleanup only deletes", async () => {
    diskFree = 100 * 1024 * 1024
    mocks.start.mockResolvedValue(makeJob({ state: "deleting" }))
    renderPage()
    expect((screen.getByDisplayValue("none") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByDisplayValue("online") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByDisplayValue("restart") as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId("database-vacuum-hint").textContent).toContain(
        "Database.Cleanup.VacuumNoSpace",
    )
    expect(screen.getByTestId("database-estimate").textContent).toContain(
        "Database.Cleanup.EstimateNoVacuum",
    )
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.ModeNone")).toBeTruthy()
    expect(screen.getByRole("alertdialog").textContent).toContain(
        "Database.Cleanup.EstimateNoVacuum",
    )
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(30, "none"))
})

test("a running cleanup shows its progress, polls and blocks another run", () => {
    usage = { data: makeUsage({ job: makeJob({ state: "vacuuming", vacuum: true }) }) }
    renderPage()
    const button = screen.getByText("Database.Cleanup.Vacuuming") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.queryByTestId("database-estimate")).toBeNull()
    expect(estimateKeys().every((k) => k === null)).toBe(true)
    const opts = mocks.swr.mock.calls.find((c) => c[0] === "/api/v1/database/usage")![2]
    expect(opts.refreshInterval(usage.data)).toBe(2000)
    expect(opts.refreshInterval(makeUsage())).toBe(0)
})

test("a rejected start is reported and the state is refreshed", async () => {
    mocks.start.mockRejectedValue(new Error("a maintenance task is running"))
    renderPage()
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("Error", {
            description: "a maintenance task is running",
        }),
    )
    expect(usageMutate).toHaveBeenCalled()
})

test("the finished job is announced once and its result stays visible", () => {
    usage = { data: makeUsage({ job: makeJob({ state: "deleting" }) }) }
    const { rerender } = renderPage()
    usage = {
        data: makeUsage({
            job: makeJob({
                state: "succeeded",
                deleted_rows: 900_000,
                freed_size: 200 * 1024 * 1024,
                vacuum_skipped: "insufficient_disk",
                finished_at: "2026-11-28T03:00:00Z",
            }),
        }),
    }
    rerender(
        <MemoryRouter>
            <DatabasePage />
        </MemoryRouter>,
    )
    expect(mocks.success).toHaveBeenCalledWith("Database.Cleanup.Finished")
    const result = screen.getByTestId("database-job-result").textContent
    expect(result).toContain("Database.Result.Succeeded")
    expect(result).toContain("Database.Result.VacuumNoSpace")
    expect(mocks.success).toHaveBeenCalledTimes(1)
})

test("a failed job shows its error and the deleted count", () => {
    usage = {
        data: makeUsage({
            job: makeJob({ state: "failed", deleted_rows: 5000, error: "disk I/O error" }),
        }),
    }
    renderPage()
    const result = screen.getByTestId("database-job-result").textContent
    expect(result).toContain("Database.Result.Failed")
    expect(result).toContain("disk I/O error")
    // loading a page with an old result does not toast
    expect(mocks.error).not.toHaveBeenCalled()
})

function hint(): string {
    return screen.getByTestId("database-vacuum-hint").textContent ?? ""
}

test("the temporary space hint never shows a placeholder", async () => {
    // estimate known, free space known
    const view = renderPage()
    expect(hint()).toContain("Database.Cleanup.VacuumHint {")
    expect(hint()).not.toMatch(/"required":"-"/)
    view.unmount()

    // free space unknown: only the required space, and why the rest is missing
    diskFree = 0
    renderPage()
    expect(hint()).toContain("Database.Cleanup.VacuumHintNoFree")
    expect(hint()).toContain('"required":"400.0 MiB"')
})

test("the hint says the space is being calculated or could not be estimated", () => {
    const base = mocks.swr.getMockImplementation()!
    mocks.swr.mockImplementation((key: unknown) =>
        Array.isArray(key) ? { data: undefined, isLoading: true } : base(key),
    )
    const view = renderPage()
    expect(hint()).toBe("Database.Cleanup.VacuumHintPending")
    view.unmount()

    mocks.swr.mockImplementation((key: unknown) =>
        Array.isArray(key)
            ? { data: undefined, error: new Error("timeout"), isLoading: false }
            : base(key),
    )
    renderPage()
    expect(hint()).toBe("Database.Cleanup.VacuumHintUnknown")
    expect(screen.getByTestId("database-estimate").textContent).toContain("timeout")
})

test("without an estimate to show the hint keeps to the general warning", () => {
    usage = { data: makeUsage({ job: makeJob({ state: "deleting" }) }) }
    const view = renderPage()
    expect(hint()).toBe("Database.Cleanup.VacuumHintBase")
    view.unmount()

    usage = { data: makeUsage() }
    renderPage()
    fireEvent.click(screen.getByDisplayValue("custom"))
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } })
    expect(hint()).toBe("Database.Cleanup.VacuumHintBase")
})

test("raw auth codes are never shown to the user", () => {
    const base = mocks.swr.getMockImplementation()!
    mocks.swr.mockImplementation((key: unknown) =>
        Array.isArray(key)
            ? { data: undefined, error: new Error("ApiErrorUnauthorized"), isLoading: false }
            : base(key),
    )
    renderPage()
    const text = screen.getByTestId("database-estimate").textContent ?? ""
    expect(text).toContain("Database.Error.Unauthorized")
    expect(text).not.toContain("ApiErrorUnauthorized")
})

test("a rejected start shows the friendly text for auth codes", async () => {
    mocks.start.mockRejectedValue(new Error("ApiErrorUnauthorized"))
    renderPage()
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("Error", {
            description: "Database.Error.Unauthorized",
        }),
    )
})

const longEstimate = {
    size_after: 900 * 1024 * 1024,
    online_vacuum_seconds: 14,
    restart_downtime_seconds: 29,
    recommended_vacuum_mode: "restart",
    recommendation_reason: "long",
}

test("a large database preselects compacting during a restart and explains why", async () => {
    restartAvailable = true
    estimateExtra = longEstimate
    mocks.start.mockResolvedValue(
        makeJob({ state: "deleting", vacuum: true, vacuum_mode: "restart" }),
    )
    renderPage()
    expect((screen.getByDisplayValue("restart") as HTMLInputElement).checked).toBe(true)
    const modes = screen.getByTestId("database-vacuum-mode").textContent ?? ""
    expect(modes).toContain("Database.Mode.Recommended")
    expect(modes).toContain(
        'Database.Mode.OnlineDetail {"duration":"Database.Duration {\\"seconds\\":14}"}',
    )
    expect(modes).toContain(
        'Database.Mode.RestartDetail {"duration":"Database.Duration {\\"seconds\\":29}"}',
    )
    expect(screen.getByTestId("database-vacuum-recommendation").textContent).toContain(
        "Database.Mode.ReasonLong",
    )
    expect(screen.getByTestId("database-estimate").textContent).toContain(
        "Database.Cleanup.EstimateWithSize",
    )

    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByTestId("database-confirm-mode").textContent).toContain(
        "Database.Confirm.ModeRestart",
    )
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.getByTestId("database-confirm-impact").textContent).toContain(
        "Database.Confirm.RestartImpact",
    )
    expect(screen.getByText("Database.Confirm.RestartRequirement")).toBeTruthy()
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(30, "restart"))
})

test("the user can still compact now against the recommendation", async () => {
    restartAvailable = true
    estimateExtra = longEstimate
    mocks.start.mockResolvedValue(makeJob({ state: "deleting", vacuum: true }))
    renderPage()
    fireEvent.click(screen.getByDisplayValue("online"))
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.getByTestId("database-confirm-impact").textContent).toContain(
        'Database.Confirm.OnlineImpact {"duration":"Database.Duration',
    )
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(30, "online"))
})

test("without automatic restart the restart option is disabled and the impact is explained", () => {
    restartAvailable = false
    estimateExtra = {
        ...longEstimate,
        recommended_vacuum_mode: "online",
        recommendation_reason: "restart_unavailable",
    }
    renderPage()
    const restart = screen.getByDisplayValue("restart") as HTMLInputElement
    expect(restart.disabled).toBe(true)
    expect((screen.getByDisplayValue("online") as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId("database-vacuum-mode").textContent).toContain(
        "Database.Mode.RestartUnavailable",
    )
    expect(screen.getByTestId("database-vacuum-recommendation").textContent).toContain(
        "Database.Mode.ReasonRestartUnavailable",
    )
})

test("a small database recommends compacting now", () => {
    restartAvailable = true
    estimateExtra = {
        ...longEstimate,
        online_vacuum_seconds: 1,
        recommended_vacuum_mode: "online",
        recommendation_reason: "short",
    }
    renderPage()
    expect((screen.getByDisplayValue("online") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByDisplayValue("restart") as HTMLInputElement).disabled).toBe(false)
    expect(screen.getByTestId("database-vacuum-recommendation").textContent).toContain(
        "Database.Mode.ReasonShort",
    )
})

test("an older dashboard without recommendations offers compacting now, not restarting", () => {
    renderPage()
    expect((screen.getByDisplayValue("online") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByDisplayValue("restart") as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByTestId("database-vacuum-recommendation")).toBeNull()
    // no duration from such dashboards: the texts leave it out
    expect(screen.getByTestId("database-vacuum-mode").textContent).toContain(
        "Database.Mode.OnlineDetailNoTime",
    )
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.ModeOnlineNoTime")).toBeTruthy()
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.getByTestId("database-confirm-impact").textContent).toBe(
        "Database.Confirm.OnlineImpactNoTime",
    )
})

test("a running cleanup shows the mode it was started with", () => {
    restartAvailable = true
    usage = {
        data: makeUsage({
            job: makeJob({ state: "deleting", vacuum: true, vacuum_mode: "restart" }),
        }),
    }
    renderPage()
    expect((screen.getByDisplayValue("restart") as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId("database-vacuum-mode").textContent).not.toContain(
        "Database.DurationUnknown",
    )
})

test("while the dashboard restarts to compact the restart overlay is shown", () => {
    usage = {
        data: makeUsage({
            job: makeJob({ state: "restarting", vacuum: true, vacuum_mode: "restart" }),
        }),
    }
    renderPage()
    expect(screen.getByText("Database.Restart.Title")).toBeTruthy()
    expect((screen.getByText("Database.Cleanup.Restarting") as HTMLButtonElement).disabled).toBe(
        true,
    )
})

test("a compaction done during the restart is reported", () => {
    usage = {
        data: makeUsage({
            job: makeJob({
                state: "succeeded",
                vacuum: true,
                vacuum_mode: "restart",
                deleted_rows: 10,
                freed_size: 100,
                finished_at: "2000-01-01T00:00:00Z",
            }),
        }),
    }
    renderPage()
    expect(screen.getByTestId("database-job-result").textContent).toContain(
        "Database.Result.RestartDone",
    )
    expect(screen.queryByText("Database.Restart.Title")).toBeNull()
})

test("the compaction notice is shown only when the server sets vacuum_recommended", () => {
    renderPage()
    expect(screen.queryByTestId("database-vacuum-recommended")).toBeNull()
    cleanup()
    usage = { data: makeUsage({ vacuum_recommended: false }) }
    renderPage()
    expect(screen.queryByTestId("database-vacuum-recommended")).toBeNull()
})

test("the compaction notice suggests a restart, or an online compaction without one", () => {
    usage = {
        data: makeUsage({
            vacuum_recommended: true,
            restart_available: true,
            free_pages_size: 800 * 1024 * 1024,
        }),
    }
    renderPage()
    const notice = screen.getByTestId("database-vacuum-recommended")
    expect(notice.textContent).toContain('Database.VacuumRecommended.Description {"size":"800')
    expect(notice.textContent).toContain("Database.VacuumRecommended.Restart")
    cleanup()

    usage = { data: makeUsage({ vacuum_recommended: true, restart_available: false }) }
    renderPage()
    expect(screen.getByTestId("database-vacuum-recommended").textContent).toContain(
        "Database.VacuumRecommended.Online",
    )
    cleanup()

    // without SQLite history there is no cleanup to compact with
    usage = { data: makeUsage({ vacuum_recommended: true, history_available: false }) }
    renderPage()
    const noCleanup = screen.getByTestId("database-vacuum-recommended")
    expect(noCleanup.textContent).toContain("Database.VacuumRecommended.NoCleanup")
    expect(screen.queryByText("Database.VacuumRecommended.Prepare")).toBeNull()
})

test("the compaction notice is hidden while a cleanup runs", () => {
    usage = {
        data: makeUsage({
            vacuum_recommended: true,
            job: makeJob({ state: "deleting", vacuum: true, vacuum_mode: "restart" }),
        }),
    }
    renderPage()
    expect(screen.queryByTestId("database-vacuum-recommended")).toBeNull()
})

test("the notice never enables a cleanup that deletes nothing", async () => {
    usage = { data: makeUsage({ vacuum_recommended: true, restart_available: true }) }
    vacuumRecommended = true
    restartAvailable = true
    renderPage()
    expect(screen.getByTestId("database-vacuum-recommended")).toBeTruthy()
    fireEvent.click(screen.getByDisplayValue("180"))
    await waitFor(() =>
        expect(screen.getByTestId("database-estimate").textContent).toContain(
            "Database.Cleanup.NothingToClean",
        ),
    )
    expect((screen.getByText("Database.Cleanup.Run") as HTMLButtonElement).disabled).toBe(true)
    // the notice is advice only: it offers no action of its own
    expect(screen.getByTestId("database-vacuum-recommended").querySelector("button")).toBeNull()
})
