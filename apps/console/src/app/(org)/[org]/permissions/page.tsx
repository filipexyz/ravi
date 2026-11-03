import { ProjectPolicyScreen } from "@/features/org/project-policy-screen";
import { OrgArea } from "@/features/org/org-area";

export default function ProjectPermissionsPage() {
  return <OrgArea tab="permissions"><ProjectPolicyScreen /></OrgArea>;
}
