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
        vacuum: true,
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
