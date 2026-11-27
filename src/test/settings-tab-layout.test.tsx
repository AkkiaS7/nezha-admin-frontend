import { SettingsTab } from "@/components/settings-tab"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: { profile: { role: 0 } as { role: number } } }))

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mocks.auth }))
vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key }),
    initReactI18next: { type: "3rdParty", init: () => undefined },
}))

afterEach(cleanup)

function renderTabs() {
    return render(
        <MemoryRouter>
            <SettingsTab />
        </MemoryRouter>,
    )
}

test("admin tabs include the database page and wrap instead of sharing fixed columns", () => {
    mocks.auth = { profile: { role: 0 } }
    const { container } = renderTabs()
    const list = screen.getByRole("tablist")
    expect(list.children).toHaveLength(9)
    // Equal columns squeeze long translations into each other.
    expect(list.className).not.toMatch(/grid-cols-/)
    expect(list.className).toContain("flex-wrap")
    expect(container.querySelector('a[href="/dashboard/settings/database"]')?.textContent).toBe(
        "Database.Tab",
    )
})

test("members only see their two tabs", () => {
    mocks.auth = { profile: { role: 1 } }
    const { container } = renderTabs()
    expect(screen.getByRole("tablist").children).toHaveLength(2)
    expect(container.querySelector('a[href="/dashboard/settings/database"]')).toBeNull()
})
