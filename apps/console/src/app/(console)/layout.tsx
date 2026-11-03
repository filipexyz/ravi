import { ConsoleWorkspaceLayout } from "@/components/console-workspace-layout";

/**
 * Console screens that belong to no organization in their URL (`/bugs`,
 * `/connectors`, `/mcp/authorize`, the `/org` picker). They open in the
 * organization this browser used last.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleWorkspaceLayout>{children}</ConsoleWorkspaceLayout>;
}
