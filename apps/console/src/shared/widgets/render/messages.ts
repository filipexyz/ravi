// Text people read from the renderer and the Pages runtime: states, field
// words, menus and confirmations. PT-BR is the product default; `en` is the
// fallback for every other locale. Confirmation text is built from the action
// (verb, record, columns and values), never from the button label.

import type { WidgetActionVerb } from "../types";

export type MessageLocale = "pt-BR" | "en";

export type ConfirmChange = { label: string; value: string };

export type RuntimeMessages = {
  locale: MessageLocale;
  // States
  loading: string;
  empty: string;
  error: string;
  retry: string;
  noPermission: string;
  writePending: string;
  saved: string;
  writeFailed: string;
  conflict: string;
  reapply: string;
  paused: string;
  capture: string;
  sessionExpired: string;
  continue: string;
  unavailable: string;
  busy: string;
  invalid: string;
  denied: string;
  unsupported: string;
  /** `app_gateway_link_required`: the action needs the person's local Ravi linked. */
  linkRequired: string;
  /** Label of the runtime status line region. */
  statusRegion: string;
  // Field words
  noValue: string;
  untitled: string;
  unknownOption: string;
  unknownPerson: string;
  yes: string;
  no: string;
  current: string;
  statusGroups: { todo: string; in_progress: string; done: string };
  /** "4 de 5". */
  outOf: (value: string, max: string) => string;
  // Collections
  count: (n: number) => string;
  /** Lane heading with its count: "A fazer (3)". */
  lane: (name: string, count: number) => string;
  laneNoValue: string;
  moveTo: string;
  /** Accessible name of the per-card move button: "Mover para…: Pedido 123". */
  moveToFor: (title: string) => string;
  moved: (title: string, lane: string) => string;
  loaded: (n: number) => string;
  tableCaption: (name: string) => string;
  /** Button after a page of rows when the view has more. */
  loadMore: string;
  /** Button and dialog title for `<ravi-view create>`. */
  newItem: string;
  // Dialogs and actions
  close: string;
  cancel: string;
  details: string;
  confirmTitle: (verb: WidgetActionVerb) => string;
  confirmBody: (verb: WidgetActionVerb, title: string, changes: readonly ConfirmChange[]) => string;
  confirmAction: (verb: WidgetActionVerb) => string;
  // Forms
  submit: string;
  submitted: string;
  /** A form submission failed for a reason that is not one field. */
  submitFailed: string;
  required: string;
  // Search, record dialog, calendar
  search: string;
  /** "Abrir" on a record that opens the record dialog, and its accessible name per record. */
  open: string;
  openFor: (title: string) => string;
  save: string;
  previousMonth: string;
  nextMonth: string;
  today: string;
  // Approval and agent cells
  approvalStates: { pending: string; approved: string; rejected: string };
  approve: string;
  reject: string;
  requestApproval: string;
  /** Decision dialog title: "Aprovar este item?" / "Recusar este item?". */
  decideTitle: (approve: boolean) => string;
  /** Decision dialog text: the record and the approval column. */
  decideBody: (title: string, column: string) => string;
  note: string;
  decided: (approve: boolean) => string;
  requested: string;
  agentPending: string;
  agentError: string;
  // Charts
  /** Accessible kind of chart by mark. */
  chartKinds: Record<"bar" | "line" | "area" | "point" | "arc" | "rect" | "text", string>;
  chartEmpty: string;
  /** Groups hidden from aggregate-mode viewers. */
  chartSuppressed: (n: number) => string;
  chartCount: string;
  // Preview document
  previewLight: string;
  previewDark: string;
  previewVariant: (name: string) => string;
  previewRecords: string;
};

function quoted(text: string) {
  return `“${text}”`;
}

/** "Status: Feito; Prazo: hoje" or, with a verb, "Status passa a ser Feito; ...". */
function changeList(changes: readonly ConfirmChange[], verb?: string) {
  return changes.map((change) => (verb ? `${change.label} ${verb} ${change.value}` : `${change.label}: ${change.value}`)).join("; ");
}

const PT_BR: RuntimeMessages = {
  locale: "pt-BR",
  loading: "Carregando…",
  empty: "Nenhum item por aqui.",
  error: "Não foi possível carregar os dados.",
  retry: "Tentar de novo",
  noPermission: "Você não tem acesso a estes dados.",
  writePending: "Salvando…",
  saved: "Salvo.",
  writeFailed: "Não foi possível salvar. A alteração foi desfeita.",
  conflict: "Alguém mudou esta linha",
  reapply: "Reaplicar",
  paused: "Dados pausados pelo operador",
  capture: "Os dados aparecem quando a página é aberta.",
  sessionExpired: "Sua sessão nesta página terminou.",
  continue: "Continuar",
  unavailable: "Indisponível",
  busy: "Muitas solicitações. Tentando de novo…",
  invalid: "Valor inválido.",
  denied: "Esta ação não é permitida.",
  unsupported: "Esta página precisa ser publicada de novo.",
  linkRequired: "Esta ação precisa do seu Ravi conectado: rode ravi link no terminal e tente de novo.",
  statusRegion: "esta página",
  noValue: "Sem valor",
  untitled: "Sem título",
  unknownOption: "Opção desconhecida",
  unknownPerson: "Pessoa desconhecida",
  yes: "Sim",
  no: "Não",
  current: "atual",
  statusGroups: { todo: "A fazer", in_progress: "Fazendo", done: "Feito" },
  outOf: (value, max) => `${value} de ${max}`,
  count: (n) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "item" : "itens"}`,
  lane: (name, count) => `${name} (${count.toLocaleString("pt-BR")})`,
  laneNoValue: "Sem valor",
  moveTo: "Mover para…",
  moveToFor: (title) => `Mover para…: ${title}`,
  moved: (title, lane) => `${quoted(title)} movido para ${lane}.`,
  loaded: (n) => (n === 1 ? "1 item carregado." : `${n.toLocaleString("pt-BR")} itens carregados.`),
  tableCaption: (name) => name,
  loadMore: "Carregar mais",
  newItem: "Novo item",
  close: "Fechar",
  cancel: "Cancelar",
  details: "Detalhes",
  confirmTitle: (verb) =>
    verb === "archive" ? "Arquivar este item?" : verb === "create" ? "Criar este item?" : verb === "update" ? "Alterar este item?" : "Abrir este item?",
  confirmBody: (verb, title, changes) => {
    const name = title ? quoted(title) : "este item";
    const subject = title ? quoted(title) : "Este item";
    if (verb === "archive") return `${subject} será arquivado e sai desta lista.`;
    if (verb === "create") return changes.length ? `Um item novo será criado com ${changeList(changes)}.` : "Um item novo será criado.";
    if (verb === "update") return changes.length ? `Em ${name}: ${changeList(changes, "passa a ser")}.` : `${subject} será alterado.`;
    return `Abrir ${name}.`;
  },
  confirmAction: (verb) => (verb === "archive" ? "Arquivar" : verb === "create" ? "Criar" : verb === "update" ? "Alterar" : "Abrir"),
  submit: "Enviar",
  submitted: "Recebido.",
  submitFailed: "Não foi possível enviar. Tente de novo.",
  required: "Obrigatório",
  search: "Buscar",
  open: "Abrir",
  openFor: (title) => `Abrir: ${title}`,
  save: "Salvar",
  previousMonth: "Mês anterior",
  nextMonth: "Próximo mês",
  today: "hoje",
  approvalStates: { pending: "Pendente", approved: "Aprovado", rejected: "Recusado" },
  approve: "Aprovar",
  reject: "Recusar",
  requestApproval: "Pedir aprovação",
  decideTitle: (approve) => (approve ? "Aprovar este item?" : "Recusar este item?"),
  decideBody: (title, column) => `${title ? quoted(title) : "Este item"}: ${column}.`,
  note: "Observação (opcional)",
  decided: (approve) => (approve ? "Aprovado." : "Recusado."),
  requested: "Aprovação pedida.",
  agentPending: "Preenchendo…",
  agentError: "Erro",
  chartKinds: { bar: "Gráfico de barras", line: "Gráfico de linhas", area: "Gráfico de área", point: "Gráfico de pontos", arc: "Gráfico de pizza", rect: "Mapa de calor", text: "Número" },
  chartEmpty: "Sem dados para este gráfico.",
  chartSuppressed: (n) => (n === 1 ? "1 grupo oculto por ter menos de 5 registros." : `${n.toLocaleString("pt-BR")} grupos ocultos por terem menos de 5 registros.`),
  chartCount: "Contagem",
  previewLight: "Claro",
  previewDark: "Escuro",
  previewVariant: (name) => `Variante ${name}`,
  previewRecords: "Registros de exemplo",
};

const EN: RuntimeMessages = {
  locale: "en",
  loading: "Loading…",
  empty: "Nothing here yet.",
  error: "Couldn't load the data.",
  retry: "Try again",
  noPermission: "You don't have access to this data.",
  writePending: "Saving…",
  saved: "Saved.",
  writeFailed: "Couldn't save. The change was undone.",
  conflict: "Someone changed this row",
  reapply: "Reapply",
  paused: "Data paused by the operator",
  capture: "The data shows up when the page is opened.",
  sessionExpired: "Your session on this page ended.",
  continue: "Continue",
  unavailable: "Unavailable",
  busy: "Too many requests. Trying again…",
  invalid: "Invalid value.",
  denied: "This action isn't allowed.",
  unsupported: "This page needs to be published again.",
  linkRequired: "This action needs your Ravi connected: run ravi link in a terminal and try again.",
  statusRegion: "this page",
  noValue: "No value",
  untitled: "Untitled",
  unknownOption: "Unknown option",
  unknownPerson: "Unknown person",
  yes: "Yes",
  no: "No",
  current: "current",
  statusGroups: { todo: "To do", in_progress: "In progress", done: "Done" },
  outOf: (value, max) => `${value} of ${max}`,
  count: (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "item" : "items"}`,
  lane: (name, count) => `${name} (${count.toLocaleString("en-US")})`,
  laneNoValue: "No value",
  moveTo: "Move to…",
  moveToFor: (title) => `Move to…: ${title}`,
  moved: (title, lane) => `${quoted(title)} moved to ${lane}.`,
  loaded: (n) => (n === 1 ? "1 item loaded." : `${n.toLocaleString("en-US")} items loaded.`),
  tableCaption: (name) => name,
  loadMore: "Load more",
  newItem: "New item",
  close: "Close",
  cancel: "Cancel",
  details: "Details",
  confirmTitle: (verb) =>
    verb === "archive" ? "Archive this item?" : verb === "create" ? "Create this item?" : verb === "update" ? "Change this item?" : "Open this item?",
  confirmBody: (verb, title, changes) => {
    const name = title ? quoted(title) : "this item";
    const subject = title ? quoted(title) : "This item";
    if (verb === "archive") return `${subject} will be archived and leave this list.`;
    if (verb === "create") return changes.length ? `A new item will be created with ${changeList(changes)}.` : "A new item will be created.";
    if (verb === "update") return changes.length ? `In ${name}: ${changeList(changes, "becomes")}.` : `${subject} will be changed.`;
    return `Open ${name}.`;
  },
  confirmAction: (verb) => (verb === "archive" ? "Archive" : verb === "create" ? "Create" : verb === "update" ? "Change" : "Open"),
  submit: "Submit",
  submitted: "Received.",
  submitFailed: "Couldn't send. Try again.",
  required: "Required",
  search: "Search",
  open: "Open",
  openFor: (title) => `Open: ${title}`,
  save: "Save",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  today: "today",
  approvalStates: { pending: "Pending", approved: "Approved", rejected: "Rejected" },
  approve: "Approve",
  reject: "Reject",
  requestApproval: "Request approval",
  decideTitle: (approve) => (approve ? "Approve this item?" : "Reject this item?"),
  decideBody: (title, column) => `${title ? quoted(title) : "This item"}: ${column}.`,
  note: "Note (optional)",
  decided: (approve) => (approve ? "Approved." : "Rejected."),
  requested: "Approval requested.",
  agentPending: "Filling in…",
  agentError: "Error",
  chartKinds: { bar: "Bar chart", line: "Line chart", area: "Area chart", point: "Point chart", arc: "Pie chart", rect: "Heatmap", text: "Number" },
  chartEmpty: "No data for this chart.",
  chartSuppressed: (n) => (n === 1 ? "1 group hidden for having fewer than 5 records." : `${n.toLocaleString("en-US")} groups hidden for having fewer than 5 records.`),
  chartCount: "Count",
  previewLight: "Light",
  previewDark: "Dark",
  previewVariant: (name) => `Variant ${name}`,
  previewRecords: "Example records",
};

/** `pt-BR` for any Portuguese locale, `en` for everything else. */
export function messageLocale(locale: string | null | undefined): MessageLocale {
  return typeof locale === "string" && /^pt(?:-|_|$)/i.test(locale) ? "pt-BR" : "en";
}

export function messages(locale: string): RuntimeMessages {
  return messageLocale(locale) === "pt-BR" ? PT_BR : EN;
}
