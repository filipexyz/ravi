"use client";

import { FeedbackForm } from "@/features/feedback/feedback-form";
import { useToast } from "@/ui/toast";
import { Dialog } from "@/ui/overlay";

export function FeedbackDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const toast = useToast();
  return (
    <Dialog
      description="It goes to the Ravi team, with the page you are on."
      onClose={onClose}
      open={open}
      title="Send feedback"
    >
      <FeedbackForm
        autoFocus
        onCancel={onClose}
        onSubmitted={() => {
          onClose();
          toast.show("Thanks. Your feedback was sent.");
        }}
      />
    </Dialog>
  );
}
