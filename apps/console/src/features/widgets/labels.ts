// PT-BR words for the widgets engine's closed lists: field types, roles,
// displays, action verbs and `set` values, as the Console shows them.

import type {
  FieldDisplayKey,
  FieldRole,
  SetValue,
  WidgetAction,
  WidgetActionVerb,
  WidgetFieldType,
} from "@/shared/widgets/types";

export const FIELD_TYPE_WORDS: Record<WidgetFieldType, string> = {
  text: "Texto",
  number: "Número",
  checkbox: "Caixa de seleção",
  date: "Data",
  select: "Seleção",
  multi_select: "Seleção múltipla",
  status: "Status",
  url: "Link",
  email: "E-mail",
  phone: "Telefone",
  person: "Pessoa",
  ref: "Referência",
};

export const FIELD_ROLE_WORDS: Record<FieldRole, string> = {
  image: "Imagem",
  avatar: "Avatar",
  highlight: "Destaque",
  progress: "Progresso",
  rating: "Avaliação",
};

/** The value kinds of `fields.json` `types` (currency and percent are number formats). */
export const DISPLAY_KEY_WORDS: Record<FieldDisplayKey, string> = {
  status: "Status",
  select: "Seleção",
  multi_select: "Seleção múltipla",
  number: "Número",
  currency: "Moeda",
  percent: "Porcentagem",
  date: "Data",
  person: "Pessoa",
  url: "Link",
  checkbox: "Caixa de seleção",
};

export const DISPLAY_WORDS: Record<string, string> = {
  pill: "Etiqueta",
  pills: "Etiquetas",
  steps: "Etapas",
  text: "Texto simples",
  number: "Número",
  compact: "Compacto (1,2 mil)",
  currency: "Moeda (R$ 1.200,00)",
  percent: "Porcentagem",
  bar: "Barra",
  ring: "Anel",
  date: "Data",
  relative: "Relativa (há 2 dias)",
  datetime: "Data e hora",
  "avatar-name": "Foto e nome",
  initials: "Iniciais",
  name: "Nome",
  link: "Link",
  domain: "Domínio",
  check: "Marca",
  "yes-no": "Sim ou não",
  cover: "Capa",
  thumb: "Miniatura",
  circle: "Círculo",
  square: "Quadrado",
  big: "Número grande",
  stars: "Estrelas",
};

export function displayWord(display: string) {
  return DISPLAY_WORDS[display] ?? display;
}

export const ACTION_VERB_WORDS: Record<WidgetActionVerb, string> = {
  update: "Atualiza o registro",
  create: "Cria um registro",
  archive: "Arquiva o registro",
  open: "Abre",
};

/** A `set` value as written in the template: `@done`, `@today`, `true`, `12`, `Pago`. */
export function setValueText(value: SetValue) {
  switch (value.kind) {
    case "status_group":
      return `@${value.group}`;
    case "now":
      return "@now";
    case "today":
      return "@today";
    case "me":
      return "@me";
    case "bool":
      return value.value ? "true" : "false";
    case "number":
      return String(value.value);
    case "literal":
      return value.value;
  }
}

/** What a button does, in one line: "Atualiza o registro: status=@done". */
export function actionSummary(action: WidgetAction) {
  const set = Object.entries(action.set).map(([field, value]) => `${field}=${setValueText(value)}`);
  if (action.verb === "open") return action.href ? `Abre o link do campo ${action.href}` : "Abre os detalhes do registro";
  return set.length ? `${ACTION_VERB_WORDS[action.verb]}: ${set.join("; ")}` : ACTION_VERB_WORDS[action.verb];
}
