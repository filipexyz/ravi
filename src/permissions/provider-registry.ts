import { dbGetSetting } from "../router/router-db.js";
import { contextCapabilitiesProvider } from "./context-capabilities-provider.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";
import { agentIdentityPermissionsProvider } from "./agent-identity-permissions-provider.js";
import { agentDefaultCapabilitiesProvider } from "./agent-default-capabilities-provider.js";
import { contactPolicyPermissionsProvider } from "./contact-policy-permissions-provider.js";
import { externalAuthorityProvider } from "./external-authority-provider.js";
import { operatorControlProvider } from "./operator-control-provider.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

export const localOperatorProvider: PermissionProvider = operatorControlProvider;

/**
 * Registro de providers de autorização endereçáveis por id.
 *
 * A cadeia passa a ser escolhida por configuração (setting
 * `permissions.provider_ids`), em vez de constante — é o ponto que faltava para
 * plugar uma autoridade EXTERNA (on-chain, serviço, MCP) sem editar o runtime.
 *
 * A configuração vem de settings do banco, não de variáveis de env como
 * `RAVI_PERMISSION_PROVIDER_IDS`: o env do processo é do agente que está sendo
 * autorizado. Limite: o banco só é autoritativo quando a checagem roda no
 * daemon (gateway do host, tools in-process). Um `ravi` executado localmente
 * abre o banco que o próprio env aponta (`RAVI_STATE_DIR`/`HOME`), igual a
 * contexts e capabilities — não é uma fronteira nova desta cadeia.
 */
const PROVIDER_REGISTRY: Record<string, () => PermissionProvider> = {
  "operator-control": () => operatorControlProvider,
  "context-capabilities": () => contextCapabilitiesProvider,
  "external-authority": () => externalAuthorityProvider,
};

export const DEFAULT_PERMISSION_PROVIDER_IDS = ["operator-control", "context-capabilities"] as const;

export const EXTERNAL_AUTHORITY_PROVIDER_IDS = ["external-authority"] as const;

export const PERMISSION_PROVIDER_IDS_SETTING = "permissions.provider_ids";

export type PermissionSettingReader = (key: string) => string | null;

/**
 * Provider que representa uma configuração inválida.
 *
 * Fail-closed: se o operador configura um id que não existe (ou indisponível
 * neste build), a decisão é NEGAR com causa explícita. Silenciar e voltar ao
 * default seria fail-open — autoridade pedida não é autoridade concedida.
 *
 * Pedidos puros do operador local ficam de fora (quem decide é o
 * `operator-control` fixo): senão um id inválido gravado direto no banco
 * trancaria o operador fora do `ravi` que corrige a config.
 */
function unavailableProvider(missingId: string): PermissionProvider {
  return {
    id: `unavailable:${missingId}`,
    version: "0",
    required: true,
    supports: (request) => !operatorControlProvider.supports(request),
    authorize(request: PermissionProviderRequest): PermissionProviderDecision {
      return {
        decision: "deny",
        allowed: false,
        providerId: `unavailable:${missingId}`,
        providerVersion: "0",
        reasonCode: "permission_provider_unavailable",
        permission: request.permission,
        objectType: request.objectType,
        objectId: request.objectId,
        ...(request.subject ? { subject: request.subject } : {}),
        evidence: [{ kind: "config", missingProviderId: missingId, available: Object.keys(PROVIDER_REGISTRY) }],
      };
    },
    materializeCapabilities: () => [],
  };
}

export function parsePermissionProviderIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readProviderIdsSetting(getSetting: PermissionSettingReader): string | null {
  try {
    return getSetting(PERMISSION_PROVIDER_IDS_SETTING);
  } catch {
    // Sem banco (bootstrap/testes): a cadeia default é a constante histórica,
    // que não concede autoridade nova — seguro cair nela.
    return null;
  }
}

/**
 * `operator-control` é o plano de controle do operador local e fica SEMPRE na
 * cadeia. Ele só aceita pedidos `localOperator` puros (sem context, subject ou
 * capabilities), então não concede nada a agentes; sem ele, uma cadeia como
 * `external-authority` deixaria o operador sem nenhum provider aplicável e o
 * `ravi` local negaria tudo — inclusive `settings delete` para desfazer a config.
 */
export const PINNED_PERMISSION_PROVIDER_ID = "operator-control";

export function getConfiguredPermissionProviderIds(getSetting: PermissionSettingReader = dbGetSetting): string[] {
  const configured = parsePermissionProviderIds(readProviderIdsSetting(getSetting));
  if (configured.length === 0) return [...DEFAULT_PERMISSION_PROVIDER_IDS];
  const unique = [...new Set(configured)];
  return unique.includes(PINNED_PERMISSION_PROVIDER_ID) ? unique : [PINNED_PERMISSION_PROVIDER_ID, ...unique];
}

export function getConfiguredPermissionProviders(
  getSetting: PermissionSettingReader = dbGetSetting,
): PermissionProvider[] {
  return getConfiguredPermissionProviderIds(getSetting).map(
    (id) => PROVIDER_REGISTRY[id]?.() ?? unavailableProvider(id),
  );
}

export function listRegisteredPermissionProviderIds(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}

// Built on first use, not at module load. This module and the contact-policy provider import each other
// through contacts and the router, so an array literal evaluated here reads `contactPolicyPermissionsProvider`
// while it is still in its temporal dead zone whenever the contact-policy module is loaded first (or the load
// order flips under load, as it did in the SDK release run of 2026-11-25).
let defaultCapabilityMaterializers: PermissionProvider[] | null = null;

export function getConfiguredCapabilityMaterializers(): PermissionProvider[] {
  defaultCapabilityMaterializers ??= [
    runtimeBootstrapProvider,
    agentDefaultCapabilitiesProvider,
    agentIdentityPermissionsProvider,
    contactPolicyPermissionsProvider,
  ];
  return defaultCapabilityMaterializers;
}
