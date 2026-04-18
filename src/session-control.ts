export const SESSION_MODEL_CHANGED_TOPIC = "ravi.session.model.changed";

export type SessionModelChangedEvent = {
  sessionKey: string;
  sessionName: string;
  modelOverride: string | null;
  effectiveModel: string;
  changedAt: number;
};
