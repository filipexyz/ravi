export type OverlayDomCommandName =
  | "query"
  | "html"
  | "text"
  | "attr"
  | "click"
  | "inject"
  | "remove"
  | "outline"
  | "clear";

export interface OverlayDomCommandRequest {
  name: OverlayDomCommandName;
  clientId?: string | null;
  selector?: string;
  index?: number;
  limit?: number;
  visible?: boolean;
  position?: "beforebegin" | "afterbegin" | "beforeend" | "afterend";
  html?: string;
  text?: string;
  attrName?: string;
  attrValue?: string | null;
}

export interface OverlayDomCommandEnvelope {
  id: string;
  targetClientId: string | null;
  createdAt: number;
  request: OverlayDomCommandRequest;
}

export interface OverlayDomNodeInfo {
  tag: string;
  text: string | null;
  html?: string | null;
  path: string[];
  attrs: Record<string, string>;
}

export interface OverlayDomCommandResult {
  id: string;
  ok: boolean;
  name: OverlayDomCommandName;
  finishedAt: number;
  targetCount?: number;
  output?: unknown;
  nodes?: OverlayDomNodeInfo[];
  error?: string;
}
