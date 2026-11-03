"use client";

import { describeError } from "@/lib/api/client";
import { Switch } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { Skeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";

import { useCalendarPolicy, useSaveCalendarPolicy } from "./api";

/**
 * The organization's rule for automatic recording from calendars. Off by
 * default; owners and admins change it, everyone else sees where it is.
 */
export function CalendarRecordingPanel() {
  const policy = useCalendarPolicy();
  const save = useSaveCalendarPolicy();
  const toast = useToast();
  return (
    <Panel padded>
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold text-ink">Calendar recording</h2>
        {policy.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : policy.isError ? (
          <p className="text-[13px] text-ink-3">{describeError(policy.error)}</p>
        ) : (
          <Switch
            checked={policy.data.autoRecordAllowed}
            description={
              <>
                People who choose &quot;Record automatically&quot; on their calendar get Ravi in every Google Meet call
                on it. Calls with anyone outside the organization still ask first, and anyone in the call who chose
                &quot;Never record&quot; holds it back unless someone asks for that call.
                {policy.data.canManage ? null : " Only owners and admins can change this."}
              </>
            }
            disabled={!policy.data.canManage || save.isPending}
            label="Members can record their calendar automatically"
            onChange={(autoRecordAllowed) =>
              save.mutate(
                { autoRecordAllowed },
                {
                  onError: (error) => toast.show(describeError(error), "err"),
                  onSuccess: () =>
                    toast.show(autoRecordAllowed ? "Automatic recording is allowed now." : "Calendars ask before recording now."),
                },
              )
            }
          />
        )}
      </div>
    </Panel>
  );
}
