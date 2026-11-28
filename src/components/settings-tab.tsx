import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/useAuth"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"

export const SettingsTab = ({ className }: { className?: string }) => {
    const { t } = useTranslation()
    const { profile } = useAuth()

    const isAdmin = profile?.role === 0
    // Admins get nine tabs: let them wrap and grow instead of squeezing them
    // into equal columns, where long translations overlap.
    const listClass = isAdmin
        ? "flex h-auto w-full flex-wrap gap-1 [&>*]:flex-auto"
        : "grid h-auto w-full grid-cols-2"

    return (
        <Tabs defaultValue={window.location.pathname} className={className}>
            <TabsList className={listClass}>
                {isAdmin && (
                    <>
                        <TabsTrigger value="/dashboard/settings" asChild>
                            <Link to="/dashboard/settings">{t("Settings")}</Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/frontends" asChild>
                            <Link to="/dashboard/settings/frontends">
                                {t("FrontendManager.Tab")}
                            </Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/backup" asChild>
                            <Link to="/dashboard/settings/backup">{t("Backup.Tab")}</Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/database" asChild>
                            <Link to="/dashboard/settings/database">{t("Database.Tab")}</Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/user" asChild>
                            <Link to="/dashboard/settings/user">{t("User")}</Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/online-user" asChild>
                            <Link to="/dashboard/settings/online-user">{t("OnlineUser")}</Link>
                        </TabsTrigger>
                        <TabsTrigger value="/dashboard/settings/waf" asChild>
                            <Link to="/dashboard/settings/waf">{t("WAF")}</Link>
                        </TabsTrigger>
                    </>
                )}
                <TabsTrigger value="/dashboard/settings/api-tokens" asChild>
                    <Link to="/dashboard/settings/api-tokens">{t("ApiTokens")}</Link>
                </TabsTrigger>
                <TabsTrigger value="/dashboard/settings/mcp-oauth" asChild>
                    <Link to="/dashboard/settings/mcp-oauth">{t("MCPOAuthManager.Title")}</Link>
                </TabsTrigger>
            </TabsList>
        </Tabs>
    )
}
