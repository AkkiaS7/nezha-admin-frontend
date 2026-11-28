import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { FetcherError } from "../api/api"
import {
    DatabaseUsage,
    databaseErrorKind,
    getDatabaseUsage,
    isJobRunning,
    isUnsupportedError,
    parseRetentionDays,
    startHistoryCleanup,
    vacuumBlockedByDisk,
} from "../api/database"

const realFetch = globalThis.fetch

beforeEach(() => {
    Object.defineProperty(document, "cookie", {
        value: "nz-csrf=example-token",
        configurable: true,
    })
})

afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
})

function respondWith(body: string, init: ResponseInit) {
    const fn = vi.fn(async () => new Response(body, init))
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
}

const job = {
    state: "idle",
    retention_days: 0,
    vacuum: false,
    deleted_rows: 0,
    freed_size: 0,
    vacuum_skipped: "",
    started_at: "",
    finished_at: "",
    error: "",
} as const

function usage(over: Partial<DatabaseUsage> = {}): DatabaseUsage {
    return {
        db_size: 300 << 20,
        free_pages_size: 0,
        disk_free: 1 << 30,
        history_available: true,
        history_rows: 1000,
        history_oldest_at: "2026-01-01T00:00:00Z",
        job,
        ...over,
    }
}

test("the usage request passes retention_days only when given", async () => {
    const fn = respondWith(JSON.stringify({ success: true, data: usage() }), { status: 200 })
    await getDatabaseUsage()
    await getDatabaseUsage(90)
    // fetcher may also fire a token refresh; look at the usage calls only.
    const urls = fn.mock.calls
        .map((c) => String((c as unknown[])[0]))
        .filter((u) => u.includes("/database/usage"))
    expect(urls[0]).toBe("/api/v1/database/usage")
    expect(new URL(urls[1]).pathname).toBe("/api/v1/database/usage")
    expect(new URL(urls[1]).searchParams.get("retention_days")).toBe("90")
})

test("starting a cleanup posts the body with the CSRF header", async () => {
    const fn = respondWith(JSON.stringify({ success: true, data: { ...job, state: "deleting" } }), {
        status: 200,
    })
    const started = await startHistoryCleanup({ retention_days: 30, vacuum: true })
    expect(started.state).toBe("deleting")
    const [path, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/api/v1/database/history-cleanup")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ retention_days: 30, vacuum: true })
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("example-token")
})

test("a dashboard without the endpoint is recognised by the 404 status, not the text", async () => {
    respondWith(JSON.stringify({ success: false, error: "404 Not Found" }), { status: 404 })
    const err = await getDatabaseUsage().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FetcherError)
    expect((err as FetcherError).status).toBe(404)
    expect(isUnsupportedError(err)).toBe(true)

    respondWith(JSON.stringify({ success: false, error: "404 Not Found" }), { status: 500 })
    expect(isUnsupportedError(await getDatabaseUsage().catch((e: unknown) => e))).toBe(false)
    // A rejected CommonResponse (HTTP 200) is not a missing endpoint either.
    respondWith(JSON.stringify({ success: false, error: "permission denied" }), { status: 200 })
    expect(isUnsupportedError(await getDatabaseUsage().catch((e: unknown) => e))).toBe(false)
})

test("custom retention accepts whole days from 1 to 3650 only", () => {
    expect(parseRetentionDays("1")).toBe(1)
    expect(parseRetentionDays(" 45 ")).toBe(45)
    expect(parseRetentionDays("3650")).toBe(3650)
    for (const bad of ["", "0", "3651", "-1", "1.5", "1e2", "abc"]) {
        expect(parseRetentionDays(bad)).toBeNull()
    }
})

test("only deleting and vacuuming count as running", () => {
    expect(isJobRunning("deleting")).toBe(true)
    expect(isJobRunning("vacuuming")).toBe(true)
    for (const s of ["idle", "succeeded", "failed", undefined] as const) {
        expect(isJobRunning(s)).toBe(false)
    }
})

test("VACUUM is blocked only when the free disk space is known to be short", () => {
    const estimate = {
        retention_days: 30,
        deletable_rows: 10,
        estimated_free_size: 1,
        vacuum_required_size: 500,
        approximate: false,
    }
    expect(vacuumBlockedByDisk(usage({ disk_free: 400, estimate }))).toBe(true)
    expect(vacuumBlockedByDisk(usage({ disk_free: 500, estimate }))).toBe(false)
    expect(vacuumBlockedByDisk(usage({ disk_free: 0, estimate }))).toBe(false)
    expect(vacuumBlockedByDisk(usage({ disk_free: 400 }))).toBe(false)
    expect(vacuumBlockedByDisk(undefined)).toBe(false)
})

test("raw auth codes and gateway failures map to friendly error kinds", () => {
    expect(databaseErrorKind(new Error("ApiErrorUnauthorized"))).toBe("unauthorized")
    expect(databaseErrorKind(new FetcherError("Unauthorized", 401))).toBe("unauthorized")
    expect(databaseErrorKind(new Error("ApiErrorForbidden: scope"))).toBe("forbidden")
    expect(databaseErrorKind(new FetcherError("HTTP 502", 502))).toBe("unavailable")
    expect(databaseErrorKind(new FetcherError("HTTP 504", 504))).toBe("unavailable")
    expect(databaseErrorKind(new TypeError("Failed to fetch"))).toBe("unavailable")
    // the server's own (localized) messages are shown as they are
    expect(databaseErrorKind(new Error("another database cleanup is in progress"))).toBeNull()
    expect(databaseErrorKind(new FetcherError("boom", 500))).toBeNull()
})
