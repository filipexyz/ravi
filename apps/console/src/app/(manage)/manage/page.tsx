import Link from "next/link";
import { Building2, Inbox, Laptop } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card, CardBody, CardHeader, PageHeader, SlashMark } from "@/components/ui";

export const dynamic = "force-dynamic";

const MODULES: Array<{ href: string; icon: LucideIcon; title: string; description: string }> = [
  {
    href: "/manage/clients",
    icon: Building2,
    title: "Clients",
    description: "Organizations you bill: contracts, monthly invoices and billing details.",
  },
  {
    href: "/manage/installations",
    icon: Laptop,
    title: "Installations",
    description: "Every Ravi linked to the Console. Mark the ones your contracts bill.",
  },
  {
    href: "/manage/bugs",
    icon: Inbox,
    title: "Bug ops",
    description: "Global inbox for reporter bugs. Confirm triage before it becomes product state.",
  },
];

export default function ManageHomePage() {
  return (
    <>
      <PageHeader
        slashLabel="manage"
        slashNum={1}
        sub="Global platform tools. Access is a Ravi platform-operator grant, not an organization role."
        title="Management"
      />
      <div className="grid grid-3">
        {MODULES.map((item, index) => (
          <Link href={item.href} key={item.href} style={{ textDecoration: "none", color: "inherit" }}>
            <Card className="card-hover">
              <CardHeader>
                <SlashMark label="module" num={index + 1} />
              </CardHeader>
              <CardBody>
                <div className="row gap-12">
                  <item.icon size={18} />
                  <div className="col gap-4">
                    <div className="t-h3">{item.title}</div>
                    <div className="t-mute t-body">{item.description}</div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
