import { describe, expect, it } from "bun:test";
import {
  DECISION_QUESTION_MAX,
  decisionHeadline,
  formatDecisionQuestion,
  parseDecisionQuestion,
  resolveDecisionQuestion,
} from "./question.js";

// The report that became dec_99cff5ca29a9496f80fa88bcba4dfaa6 on 27/11: a whole design report used as the question.
const REAL_REPORT =
  "Rev. 3 pronta: /Users/luis/ravi/main/outputs/identidade-console/desenho.md. O que mudou: (1) link obrigatório como regra do produto, sem exceção: todo comando tem como principal uma pessoa com ravi link; o dono, os repasses, cron, trigger e observer passam pelo link; a tag permission-owner some; ravi login vira só transporte. (2) Sistema de modo. Minha leitura: o modo é da superfície (chat), herdado org → instância → chat, definido no Console, e diz só o que recebe quem escreve sem link. Decisões, com recomendação: (1) turno sem pessoa roda como o dono do job pelo link dele ∩ papel do agente; (2) vinculado como padrão em toda org; (3) Console fora: concessão de 15 min + carência de 45 min.";

describe("resolveDecisionQuestion", () => {
  it("refuses a long report as the question and says how to ask", () => {
    expect(() => resolveDecisionQuestion({ report: REAL_REPORT })).toThrow(/--ask/);
    try {
      resolveDecisionQuestion({ report: REAL_REPORT });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("DECISION_QUESTION_INVALID");
    }
  });

  it("refuses a multi-line report even when short", () => {
    expect(() => resolveDecisionQuestion({ report: "Faço o deploy?\nContexto." })).toThrow(/--ask/);
  });

  it("keeps a short one-line report as the question", () => {
    expect(resolveDecisionQuestion({ report: "Faço o deploy hoje?" })).toEqual({
      question: "Faço o deploy hoje?",
      options: [],
      recommendation: null,
    });
  });

  it("uses --ask, options and recommendation, and never the report", () => {
    const resolved = resolveDecisionQuestion({
      report: REAL_REPORT,
      ask: "Qual modo é o padrão para quem escreve sem ravi link?",
      options: ["vinculado: só o convite", "conversa: agente sem ferramentas"],
      recommend: "vinculado em toda org",
    });
    expect(resolved.question).toBe("Qual modo é o padrão para quem escreve sem ravi link?");
    expect(resolved.options).toHaveLength(2);
    expect(formatDecisionQuestion(resolved)).not.toContain("Rev. 3");
  });

  it("bounds the question, the options and their count", () => {
    expect(() => resolveDecisionQuestion({ report: "x", ask: "q".repeat(DECISION_QUESTION_MAX + 1) })).toThrow(/280/);
    expect(() => resolveDecisionQuestion({ report: "x", ask: "q?", options: ["o".repeat(161)] })).toThrow(/160/);
    expect(() => resolveDecisionQuestion({ report: "x", ask: "q?", options: Array(7).fill("a") })).toThrow(/6/);
    expect(() => resolveDecisionQuestion({ report: "x", options: ["a"] })).toThrow(/need --ask/);
  });
});

describe("format and parse", () => {
  it("round-trips a structured question", () => {
    const question = { question: "Faço o deploy?", options: ["sim", "não"], recommendation: "sim, hoje" };
    expect(parseDecisionQuestion(formatDecisionQuestion(question))).toEqual(question);
    expect(
      parseDecisionQuestion(formatDecisionQuestion({ question: "Só isso?", options: [], recommendation: null })),
    ).toEqual({ question: "Só isso?", options: [], recommendation: null });
  });

  it("does not read a free-form question as structured", () => {
    expect(parseDecisionQuestion(REAL_REPORT)).toBeNull();
    expect(parseDecisionQuestion("Faço o deploy?\nContexto longo do relatório.")).toBeNull();
  });

  it("the headline is one bounded line", () => {
    expect(decisionHeadline(REAL_REPORT).length).toBeLessThanOrEqual(DECISION_QUESTION_MAX);
    expect(decisionHeadline("Pergunta?\nOpções:\n- a")).toBe("Pergunta?");
  });
});
