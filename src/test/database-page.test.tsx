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
vi.mock("swr", () => ({ default: mocks.swr }))
vi.mock("@/api/database", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/api/database")>()),
    startHistoryCleanup: mocks.start,
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
const usageMutate = vi.fn()

beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth = { profile: { role: 0 }, loading: false }
    usage = { data: makeUsage() }
    deletableRows = (days) => (days >= 180 ? 0 : Math.round(900_000 / days) * 30)
    diskFree = 8 * 1024 * 1024 * 1024
    mocks.swr.mockImplementation((key: unknown) => {
        if (key === "/api/v1/database/usage")
            return { ...usage, mutate: usageMutate, isLoading: false }
        if (Array.isArray(key)) {
            const days = key[1] as number
            const rows = deletableRows(days)
            return {
                data: makeUsage({
                    disk_free: diskFree,
                    estimate: {
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
    expect(screen.getByTestId("database-estimate").textContent).toContain('"rows":"900,000"')

    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.Title")).toBeTruthy()
    expect(screen.getByText("Database.Confirm.WithVacuum")).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.getByText("Database.Confirm.FinalTitle")).toBeTruthy()
    expect(screen.getByText("Database.Confirm.VacuumLock")).toBeTruthy()
    expect(screen.getByText("Database.Confirm.GoBackup").getAttribute("href")).toBe(
        "/dashboard/settings/backup",
    )
    expect(mocks.start).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() =>
        expect(mocks.start).toHaveBeenCalledWith({ retention_days: 30, vacuum: true }),
    )
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

test("unchecking VACUUM sends vacuum false", async () => {
    mocks.start.mockResolvedValue(makeJob({ state: "deleting" }))
    renderPage()
    fireEvent.click(screen.getByLabelText("Database.Cleanup.Vacuum"))
    fireEvent.click(screen.getByDisplayValue("90"))
    await waitFor(() => expect(estimateKeys().some((k) => k[1] === 90)).toBe(true))
    await waitFor(() => expect(screen.getByText("Database.Cleanup.Run")).toBeTruthy())
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    expect(screen.getByText("Database.Confirm.WithoutVacuum")).toBeTruthy()
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    expect(screen.queryByText("Database.Confirm.VacuumLock")).toBeNull()
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() =>
        expect(mocks.start).toHaveBeenCalledWith({ retention_days: 90, vacuum: false }),
    )
})

test("custom days below 30 warn about the charts; invalid input disables the cleanup", async () => {
    renderPage()
    fireEvent.click(screen.getByDisplayValue("custom"))
    const input = screen.getByRole("spinbutton")

    fireEvent.change(input, { target: { value: "7" } })
    expect(screen.getByTestId("database-short-retention")).toBeTruthy()
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
    const box = screen.getByLabelText("Database.Cleanup.Vacuum")
    expect(box.getAttribute("data-state")).toBe("unchecked")
    expect((box as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("database-vacuum-hint").textContent).toContain(
        "Database.Cleanup.VacuumNoSpace",
    )
    fireEvent.click(screen.getByText("Database.Cleanup.Run"))
    fireEvent.click(screen.getByText("Database.Confirm.Next"))
    fireEvent.click(screen.getByText("Database.Confirm.Run"))
    await waitFor(() =>
        expect(mocks.start).toHaveBeenCalledWith({ retention_days: 30, vacuum: false }),
    )
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
