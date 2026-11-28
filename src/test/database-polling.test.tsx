// Polling behaviour with the real SWR scheduler (refreshInterval, error retry)
// and fake timers, so regressions in how failures reach SWR are caught.
import type { DatabaseCleanupJob, DatabaseUsage } from "@/api/database"
import DatabasePage from "@/routes/database"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    start: vi.fn(),
}))

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ profile: { role: 0 }, loading: false }) }))
vi.mock("@/components/settings-tab", () => ({ SettingsTab: () => null }))
vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key }),
    initReactI18next: { type: "3rdParty", init: () => undefined },
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock("@/api/database", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/api/database")>()),
    getDatabaseUsage: mocks.get,
    startHistoryCleanup: mocks.start,
}))

function job(state: DatabaseCleanupJob["state"]): DatabaseCleanupJob {
    return {
        state,
        retention_days: 30,
        // no compaction: the generic failure handling; tests set vacuum_mode otherwise
        vacuum: false,
        deleted_rows: 0,
        freed_size: 0,
        vacuum_skipped: "",
        started_at: "",
        finished_at: "",
        error: "",
    }
}

function usage(state: DatabaseCleanupJob["state"], withEstimate = false): DatabaseUsage {
    return {
        db_size: 1000,
        free_pages_size: 0,
        disk_free: 1 << 30,
        history_available: true,
        history_rows: 100,
        history_oldest_at: "",
        ...(withEstimate
            ? {
                  estimate: {
                      retention_days: 30,
                      deletable_rows: 50,
                      estimated_free_size: 500,
                      vacuum_required_size: 1000,
                      approximate: false,
                  },
              }
            : {}),
        job: job(state),
    }
}

const locked = () => Promise.reject(new Error("database is locked"))

let cacheMap: Map<string, unknown>

beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    cacheMap = new Map()
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function renderPage() {
    return render(
        <SWRConfig value={{ provider: () => cacheMap as never, dedupingInterval: 0 }}>
            <MemoryRouter>
                <DatabasePage />
            </MemoryRouter>
        </SWRConfig>,
    )
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const pollCalls = () => mocks.get.mock.calls.filter((c) => c[0] === undefined).length
const notice = () => screen.queryByText("Database.Cleanup.PollFailed")

test("polling keeps its 2 s rhythm through failures, reports the third and clears on recovery", async () => {
    mocks.get.mockResolvedValueOnce(usage("deleting"))
    renderPage()
    await tick(0)
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
    expect(pollCalls()).toBe(1)

    mocks.get.mockImplementation(locked)
    await tick(2000)
    await tick(2000)
    expect(pollCalls()).toBe(3)
    expect(notice()).toBeNull()

    await tick(2000)
    expect(pollCalls()).toBe(4)
    expect(notice()).toBeTruthy()
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
    expect(screen.queryByText("Results.ErrorFetchingResource")).toBeNull()

    // still the regular interval, not SWR's error backoff
    await tick(2000)
    await tick(2000)
    expect(pollCalls()).toBe(6)

    // recovery clears the notice and the count
    mocks.get.mockResolvedValueOnce(usage("vacuuming"))
    await tick(2000)
    expect(notice()).toBeNull()
    expect(screen.getByText("Database.Cleanup.Vacuuming")).toBeTruthy()
    mocks.get.mockImplementationOnce(locked)
    await tick(2000)
    expect(notice()).toBeNull()

    // a finished job stops polling
    mocks.get.mockResolvedValue({
        ...usage("succeeded"),
        job: { ...job("succeeded"), finished_at: "2000-01-01T00:00:00Z" },
    })
    await tick(2000)
    const calls = pollCalls()
    await tick(10000)
    expect(pollCalls()).toBe(calls)
    expect(screen.getByTestId("database-job-result")).toBeTruthy()
})

test("a failed poll right after starting the cleanup is tolerated", async () => {
    mocks.get.mockImplementation((days?: number) =>
        Promise.resolve(usage("idle", days !== undefined)),
    )
    mocks.start.mockResolvedValue(job("deleting"))
    renderPage()
    await tick(0)
    await tick(0)

    mocks.get.mockImplementation(locked)
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await tick(0)
    await tick(0)

    expect(mocks.start).toHaveBeenCalled()
    expect(pollCalls()).toBeGreaterThanOrEqual(2) // the revalidation after the POST failed
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
})

test("coming back to the page with a running job in the cache tolerates a failed poll", async () => {
    mocks.get.mockResolvedValueOnce(usage("deleting"))
    const first = renderPage()
    await tick(0)
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
    first.unmount()

    mocks.get.mockImplementation(locked)
    renderPage()
    // with cached data SWR revalidates on the next animation frame
    await tick(50)
    expect(pollCalls()).toBe(2)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
})

test("without a running job a failure is shown at once", async () => {
    mocks.get.mockImplementation(locked)
    renderPage()
    await tick(0)
    expect(screen.getByText("Results.ErrorFetchingResource")).toBeTruthy()
    expect(notice()).toBeNull()
})

test("a failed poll during an online compaction explains the stall at once", async () => {
    mocks.get.mockResolvedValueOnce({
        ...usage("vacuuming"),
        job: { ...job("vacuuming"), vacuum_mode: "online" },
    })
    renderPage()
    await tick(0)
    mocks.get.mockImplementation(() => Promise.reject(new Error("ApiErrorUnauthorized")))
    await tick(2000)
    expect(screen.getByText("Database.Cleanup.PollFailedOnline")).toBeTruthy()
    expect(screen.queryByText(/ApiErrorUnauthorized/)).toBeNull()
    // polling goes on and recovers
    mocks.get.mockResolvedValue({
        ...usage("succeeded"),
        job: { ...job("succeeded"), vacuum_mode: "online", finished_at: "2000-01-01T00:00:00Z" },
    })
    await tick(2000)
    expect(screen.queryByText("Database.Cleanup.PollFailedOnline")).toBeNull()
    expect(screen.getByTestId("database-job-result")).toBeTruthy()
})

const restartJob = (
    state: DatabaseCleanupJob["state"],
    over: Partial<DatabaseCleanupJob> = {},
) => ({
    ...usage(state),
    job: { ...job(state), vacuum_mode: "restart" as const, ...over },
})
const overlay = () => screen.queryByText("Database.Restart.Title")

test("a brief disconnect while deleting does not count as the restart", async () => {
    mocks.get.mockResolvedValueOnce(restartJob("deleting"))
    renderPage()
    await tick(0)
    mocks.get.mockImplementationOnce(locked).mockImplementationOnce(locked)
    await tick(2000)
    await tick(2000)
    expect(overlay()).toBeNull()
    // back with the deletion still going: nothing happened
    mocks.get.mockResolvedValue(restartJob("deleting"))
    await tick(2000)
    expect(overlay()).toBeNull()
    expect(screen.getByText("Database.Cleanup.Deleting")).toBeTruthy()
})

test("a missed restarting state is caught after several failed polls in a row", async () => {
    mocks.get.mockResolvedValueOnce(restartJob("deleting"))
    renderPage()
    await tick(0)
    mocks.get.mockImplementation(locked)
    await tick(2000)
    await tick(2000)
    expect(overlay()).toBeNull()
    await tick(2000)
    expect(overlay()).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    // the dashboard is back with the result of this cleanup
    mocks.get.mockResolvedValue(
        restartJob("succeeded", { deleted_rows: 10, finished_at: "2000-01-01T00:00:00Z" }),
    )
    await tick(2000)
    expect(overlay()).toBeNull()
    expect(screen.getByTestId("database-job-result").textContent).toContain(
        "Database.Result.RestartDone",
    )
})

test("the overlay lasts until this cleanup's final state, not while the old process answers", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)
    mocks.get.mockResolvedValue(restartJob("restarting"))
    renderPage()
    await tick(0)
    expect(overlay()).toBeTruthy()
    // the old process keeps answering "restarting" for a while: keep waiting
    await tick(20000)
    expect(overlay()).toBeTruthy()
    // then it goes down: still waiting, no error shown
    mocks.get.mockImplementation(locked)
    await tick(20000)
    expect(overlay()).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    // the anonymous probe of the backup restore is not used here
    expect(fetchSpy).not.toHaveBeenCalled()
    mocks.get.mockResolvedValue(
        restartJob("failed", { error: "VACUUM failed", finished_at: "2000-01-01T00:00:00Z" }),
    )
    await tick(2000)
    expect(overlay()).toBeNull()
    expect(screen.getByTestId("database-job-result").textContent).toContain("VACUUM failed")
    vi.unstubAllGlobals()
})

test("a dashboard that does not come back ends in the timeout message", async () => {
    mocks.get.mockResolvedValueOnce(restartJob("restarting"))
    renderPage()
    await tick(0)
    mocks.get.mockImplementation(locked)
    await tick(4 * 60 * 1000)
    expect(screen.queryByText("Backup.Restart.Timeout")).toBeNull()
    await tick(60 * 1000 + 2000)
    expect(screen.getByText("Backup.Restart.Timeout")).toBeTruthy()
    expect(screen.getByText("Backup.Restart.GoToLogin")).toBeTruthy()
})

test("a failed poll while an online cleanup still reads as deleting says it may be compacting", async () => {
    mocks.get.mockResolvedValueOnce({
        ...usage("deleting"),
        job: { ...job("deleting"), vacuum_mode: "online" },
    })
    renderPage()
    await tick(0)
    mocks.get.mockImplementationOnce(locked)
    await tick(2000)
    expect(screen.getByText("Database.Cleanup.PollFailedMaybeVacuuming")).toBeTruthy()
    mocks.get.mockResolvedValue({
        ...usage("vacuuming"),
        job: { ...job("vacuuming"), vacuum_mode: "online" },
    })
    await tick(2000)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Database.Cleanup.Vacuuming")).toBeTruthy()
})
