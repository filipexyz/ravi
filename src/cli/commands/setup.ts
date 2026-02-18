/**
 * Setup Command - Wizard interativo para configurar o Ravi
 */

import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const RAVI_DOT_DIR = join(homedir(), ".ravi");
const ENV_FILE = join(RAVI_DOT_DIR, ".env");

// ============================================================================
// ANSI helpers
// ============================================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

const ok = `${c.green}✓${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const bullet = `${c.gray}›${c.reset}`;
const arrow = `${c.cyan}❯${c.reset}`;

function heading(step: number, total: number, title: string, detail: string) {
  console.log();
  console.log(`  ${c.cyan}${c.bold}[${step}/${total}]${c.reset} ${c.bold}${title}${c.reset}`);
  console.log(`  ${c.gray}${detail}${c.reset}`);
  console.log();
}

function done(msg: string) {
  console.log(`    ${ok} ${msg}`);
}

function skip(msg: string) {
  console.log(`    ${c.gray}${msg} — já configurado${c.reset}`);
}

function warning(msg: string) {
  console.log(`    ${warn} ${c.yellow}${msg}${c.reset}`);
}

function info(msg: string) {
  console.log(`    ${c.gray}${msg}${c.reset}`);
}

// ============================================================================
// Prompt helpers
// ============================================================================

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      let input = "";

      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          console.log();
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          process.exit(1);
        } else if (c === "\u007F" || c === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += c;
        }
      };

      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function ask(label: string, opts?: { default?: string; hidden?: boolean }): Promise<string> {
  const def = opts?.default;
  const suffix = def ? ` ${c.gray}(${def})${c.reset}` : "";
  const answer = await prompt(`    ${arrow} ${label}${suffix} `, opts?.hidden);
  return answer.trim() || def || "";
}

async function choose(label: string, options: string[], defaultIdx = 0): Promise<string> {
  const optStr = options
    .map((o, i) => (i === defaultIdx ? `${c.white}${c.bold}${o}${c.reset}` : `${c.gray}${o}${c.reset}`))
    .join(`${c.gray}/${c.reset}`);
  const answer = await prompt(`    ${arrow} ${label} ${optStr} `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return options[defaultIdx];
  const match = options.find(o => o.toLowerCase() === trimmed);
  return match || options[defaultIdx];
}

// ============================================================================
// .env helpers
// ============================================================================

function parseEnvFile(path: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync(path)) return env;

  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && value) {
      env.set(key, value);
    }
  }
  return env;
}

function appendEnvKey(key: string, value: string): void {
  appendFileSync(ENV_FILE, `${key}=${value}\n`);
}

// ============================================================================
// Wizard steps
// ============================================================================

async function stepEnvironment(): Promise<void> {
  heading(1, 4, "Ambiente", "~/.ravi/.env");

  mkdirSync(RAVI_DOT_DIR, { recursive: true });

  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, "# Ravi Daemon - Variáveis de ambiente\n\n");
  }

  const env = parseEnvFile(ENV_FILE);

  // nats-server binary (local infrastructure)
  const { ensureNatsBinary } = await import("../../local/binary.js");
  try {
    await ensureNatsBinary({
      onProgress: (msg) => info(msg),
    });
    done("nats-server instalado");
  } catch (err: any) {
    warning(`Falha ao baixar nats-server: ${err.message}`);
  }

  // Claude auth
  const hasAnthropicKey = env.has("ANTHROPIC_API_KEY");
  const hasOAuthToken = env.has("CLAUDE_CODE_OAUTH_TOKEN");

  if (hasAnthropicKey || hasOAuthToken) {
    if (hasAnthropicKey) skip("ANTHROPIC_API_KEY");
    if (hasOAuthToken) skip("CLAUDE_CODE_OAUTH_TOKEN");
  } else {
    const method = await choose("Autenticação Claude", ["API key", "OAuth token"], 0);
    if (method === "OAuth token") {
      info("Execute `claude setup-token` para obter o token");
      const val = await ask("CLAUDE_CODE_OAUTH_TOKEN", { hidden: true });
      if (val) {
        appendEnvKey("CLAUDE_CODE_OAUTH_TOKEN", val);
        done("CLAUDE_CODE_OAUTH_TOKEN salvo");
      }
    } else {
      const val = await ask("ANTHROPIC_API_KEY", { hidden: true });
      if (val) {
        appendEnvKey("ANTHROPIC_API_KEY", val);
        done("ANTHROPIC_API_KEY salvo");
      }
    }
  }

  // Opcional: OPENAI_API_KEY
  if (env.has("OPENAI_API_KEY")) {
    skip("OPENAI_API_KEY");
  } else {
    const val = await ask("OpenAI key — transcrição de áudio", { hidden: true });
    if (val) {
      appendEnvKey("OPENAI_API_KEY", val);
      done("OPENAI_API_KEY salvo");
    } else {
      info("Pulado — pode configurar depois");
    }
  }

  // Opcional: RAVI_MODEL
  if (env.has("RAVI_MODEL")) {
    skip(`RAVI_MODEL (${env.get("RAVI_MODEL")})`);
  } else {
    const val = await choose("Modelo", ["sonnet", "haiku", "opus"], 0);
    if (val !== "sonnet") {
      appendEnvKey("RAVI_MODEL", val);
    }
    done(`Modelo: ${val}`);
  }
}

async function stepAgent(): Promise<void> {
  heading(2, 4, "Agente", "~/ravi/main");

  const { dbListAgents, dbCreateAgent, dbSetSetting } = await import("../../router/router-db.js");
  const { ensureAgentDirs, loadRouterConfig } = await import("../../router/config.js");

  const agents = dbListAgents();

  if (agents.length > 0) {
    const names = agents.map(a => `${c.cyan}${a.id}${c.reset}`).join(", ");
    console.log(`    ${ok} Agentes existentes: ${names}`);
    return;
  }

  const id = await ask("Nome do agente", { default: "main" });
  const defaultCwd = `~/ravi/${id}`;
  const cwd = await ask("Diretório", { default: defaultCwd });

  dbCreateAgent({ id, cwd });
  dbSetSetting("defaultAgent", id);

  ensureAgentDirs(loadRouterConfig());

  const resolvedCwd = cwd.replace("~", homedir());
  const claudeMdPath = join(resolvedCwd, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# ${id}\n\nInstruções do agente aqui.\n`);
  }

  done(`Agente ${c.cyan}${id}${c.reset} criado em ${c.gray}${cwd}${c.reset}`);
}

async function stepSettings(): Promise<void> {
  heading(3, 4, "Configurações", "fuso horário, políticas");

  const { dbGetSetting, dbSetSetting } = await import("../../router/router-db.js");

  // defaultTimezone
  const existingTz = dbGetSetting("defaultTimezone");
  if (existingTz) {
    skip(`Fuso horário (${existingTz})`);
  } else {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tz = await ask("Fuso horário", { default: detected });
    dbSetSetting("defaultTimezone", tz);
    done(`Fuso horário: ${c.cyan}${tz}${c.reset}`);
  }

  // whatsapp.dmPolicy
  const existingDm = dbGetSetting("whatsapp.dmPolicy");
  if (existingDm) {
    skip(`DM policy (${existingDm})`);
  } else {
    const val = await choose("WhatsApp DMs", ["open", "pairing", "closed"], 1);
    dbSetSetting("whatsapp.dmPolicy", val);
    done(`DM policy: ${c.cyan}${val}${c.reset}`);
  }

  // whatsapp.groupPolicy
  const existingGroup = dbGetSetting("whatsapp.groupPolicy");
  if (existingGroup) {
    skip(`Group policy (${existingGroup})`);
  } else {
    const val = await choose("WhatsApp grupos", ["open", "allowlist", "closed"], 1);
    dbSetSetting("whatsapp.groupPolicy", val);
    done(`Group policy: ${c.cyan}${val}${c.reset}`);
  }
}

async function stepDaemon(): Promise<void> {
  heading(4, 4, "Daemon", "instalar + iniciar");

  try {
    execSync("ravi daemon install", { stdio: "pipe" });
    done("Serviço instalado");
  } catch {
    warning("Não foi possível instalar — execute: ravi daemon install");
  }

  try {
    execSync("ravi daemon start", { stdio: "pipe" });
    done("Daemon iniciado");
  } catch (err: any) {
    const msg = err?.stderr?.toString() || err?.stdout?.toString() || "";
    if (msg.includes("already running")) {
      done("Daemon já está rodando");
    } else {
      warning("Não foi possível iniciar — execute: ravi daemon start");
    }
  }
}

// ============================================================================
// Main entry
// ============================================================================

export async function runSetup(): Promise<void> {
  console.log();
  console.log(`  ${c.bold}Ravi Bot${c.reset} ${c.gray}— setup${c.reset}`);
  console.log(`  ${c.gray}${"─".repeat(30)}${c.reset}`);

  await stepEnvironment();
  await stepAgent();
  await stepSettings();
  await stepDaemon();

  console.log();
  console.log(`  ${c.green}${c.bold}Configuração completa!${c.reset}`);
  console.log();
  console.log(`  ${c.gray}Próximos passos:${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi daemon logs -f${c.reset}       ${c.gray}Ver QR code do WhatsApp${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi agents chat main${c.reset}     ${c.gray}Testar o agente${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi contacts pending${c.reset}     ${c.gray}Aprovar contatos pendentes${c.reset}`);
  console.log();
}
