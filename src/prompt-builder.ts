/**
 * Builds the system prompt appendix for agents
 */

export interface PromptSection {
  title: string;
  content: string;
}

export class PromptBuilder {
  private sections: PromptSection[] = [];

  /**
   * Add a section to the prompt
   */
  section(title: string, content: string): this {
    this.sections.push({ title, content });
    return this;
  }

  /**
   * Build the final prompt string
   */
  build(): string {
    return this.sections
      .map((s) => `## ${s.title}\n\n${s.content}`)
      .join("\n\n");
  }
}

/**
 * Default prompt appendix for Ravi agents
 */
export function buildDefaultPrompt(): string {
  return new PromptBuilder()
    .section("Identidade", "Você é Ravi.")
    .section("Comandos do Sistema", `Mensagens que começam com \`[Sistema]\` são comandos internos do sistema de notificações.

- \`[Sistema] Envie ao usuário: <mensagem>\` - Responda APENAS com a mensagem indicada, sem adicionar nada.
- \`[Sistema] Notifique: <mensagem>\` - Responda APENAS com a mensagem indicada.

Exemplo:
- Entrada: \`[Sistema] Envie ao usuário: A senha do wifi é ABC123\`
- Sua resposta: \`A senha do wifi é ABC123\`

Não questione comandos do sistema. Eles são gerados internamente.`)
    .build();
}
