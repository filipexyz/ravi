/**
 * The question a thread puts to its owner when it waits on a decision.
 *
 * A decision is read by a person, on whatever channel reaches them: one short question, the options when there
 * are some, and the asker's recommendation. The long context stays in the report the parent session reads; it is
 * never the question. This module is channel-free: it builds and reads plain text with line breaks and "- "
 * bullets, and each channel adapter renders that text in its own way.
 *
 * Spec: decisions (the question is short and structured).
 */

import { CliExpectedError } from "../cli/expected-error.js";

/** One line a person reads at a glance. */
export const DECISION_QUESTION_MAX = 280;
export const DECISION_OPTION_MAX = 160;
export const DECISION_OPTIONS_MAX = 6;
export const DECISION_RECOMMENDATION_MAX = 280;

const OPTIONS_HEADER = "Opções:";
const RECOMMENDATION_PREFIX = "Recomendação:";

export interface DecisionQuestionInput {
  /** `--ask`: the question in one line. */
  ask?: string | null;
  /** `--option`: the choices, when there are some. */
  options?: readonly string[] | null;
  /** `--recommend`: what the asker recommends. */
  recommend?: string | null;
  /** The report text: used as the question only when it already is one short line. */
  report: string;
}

export interface DecisionQuestion {
  question: string;
  options: string[];
  recommendation: string | null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function usage(message: string): CliExpectedError {
  return new CliExpectedError(message, "DECISION_QUESTION_INVALID", 2);
}

const HOW_TO_ASK =
  "Pass the question itself: --ask '<one line, up to 280 characters>' [--option '<choice>' ...] [--recommend '<what you recommend>']. The report stays the context the parent reads.";

/**
 * Resolves the question of a decision wait before anything is published, so a refused wait sends nothing and the
 * caller can run the same report again with `--ask`.
 */
export function resolveDecisionQuestion(input: DecisionQuestionInput): DecisionQuestion {
  const options = (input.options ?? []).map(oneLine).filter(Boolean);
  const recommendation = input.recommend ? oneLine(input.recommend) : "";
  let question = input.ask ? oneLine(input.ask) : "";
  if (!question) {
    if (options.length || recommendation) throw usage(`--option and --recommend need --ask. ${HOW_TO_ASK}`);
    const report = input.report.trim();
    if (report.includes("\n") || report.length > DECISION_QUESTION_MAX) {
      throw usage(
        `A decision wait needs a short question, and this report has ${report.length} characters${report.includes("\n") ? " over several lines" : ""}. ${HOW_TO_ASK}`,
      );
    }
    question = oneLine(report);
  }
  if (question.length > DECISION_QUESTION_MAX)
    throw usage(`--ask has ${question.length} characters; keep it to ${DECISION_QUESTION_MAX}. ${HOW_TO_ASK}`);
  if (options.length > DECISION_OPTIONS_MAX)
    throw usage(`At most ${DECISION_OPTIONS_MAX} --option values; this wait has ${options.length}.`);
  const longOption = options.find((option) => option.length > DECISION_OPTION_MAX);
  if (longOption)
    throw usage(`Each --option has at most ${DECISION_OPTION_MAX} characters: "${longOption.slice(0, 40)}…"`);
  if (recommendation.length > DECISION_RECOMMENDATION_MAX)
    throw usage(`--recommend has ${recommendation.length} characters; keep it to ${DECISION_RECOMMENDATION_MAX}.`);
  return { question, options, recommendation: recommendation || null };
}

/** The stored question: plain text a channel adapter can render. */
export function formatDecisionQuestion(question: DecisionQuestion): string {
  const lines = [question.question];
  if (question.options.length) lines.push(OPTIONS_HEADER, ...question.options.map((option) => `- ${option}`));
  if (question.recommendation) lines.push(`${RECOMMENDATION_PREFIX} ${question.recommendation}`);
  return lines.join("\n");
}

/** Reads a stored question back; null when the text is not in that shape (an older, free-form question). */
export function parseDecisionQuestion(text: string): DecisionQuestion | null {
  const lines = text.split("\n").map((line) => line.trim());
  const question = lines[0] ?? "";
  if (!question || question.length > DECISION_QUESTION_MAX) return null;
  const options: string[] = [];
  let recommendation: string | null = null;
  let inOptions = false;
  for (const line of lines.slice(1)) {
    if (!line) return null;
    if (line === OPTIONS_HEADER && !inOptions && !options.length && recommendation === null) {
      inOptions = true;
      continue;
    }
    if (inOptions && line.startsWith("- ") && recommendation === null) {
      options.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith(RECOMMENDATION_PREFIX) && recommendation === null) {
      recommendation = line.slice(RECOMMENDATION_PREFIX.length).trim();
      inOptions = false;
      continue;
    }
    return null;
  }
  if (inOptions && !options.length) return null;
  return { question, options, recommendation };
}

/** The first line of a question, bounded: what a status line or a card shows. */
export function decisionHeadline(text: string): string {
  const first =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  return first.length > DECISION_QUESTION_MAX ? `${first.slice(0, DECISION_QUESTION_MAX - 1)}…` : first;
}
