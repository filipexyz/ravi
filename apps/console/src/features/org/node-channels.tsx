"use client";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Installation, RuntimeOperation } from "@ravi/operation-contracts/console";
import { Button } from "@/ui/button";
import { Field, Input, FormMessage } from "@/ui/form";
import { useNodeClient } from "./node-queries";

const labels = { queued: "Aguardando a instalação", delivered: "Aplicando configuração", succeeded: "Configuração confirmada", failed: "A configuração falhou", uncertain: "Resultado ainda não confirmado", cancelled: "Operação cancelada" };

/** Optional management, using the same native adapters and credential broker as the CLI. */
export function NodeChannels({ node }: { node: Installation }) {
  const { sdk, key } = useNodeClient(), cache = useQueryClient();
  const [inspection, setInspection] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(""), [connection, setConnection] = useState("");
  const intent = useRef<{ input: string; id: string } | null>(null);
  const managed = useQuery({ queryKey: key("channels"), queryFn: () => sdk.channels.list({}), retry: false, refetchInterval: 3000 });
  const inventory = useQuery({ queryKey: key("operation", inspection), queryFn: () => sdk.operations.show({ operationId: inspection! }), enabled: !!inspection, retry: false,
    refetchInterval: query => query.state.data && ["queued", "delivered"].includes(query.state.data.status) ? 2000 : false });
  const connections = inventory.data?.result?.kind === "channels.inspect" ? inventory.data.result.connections : [];
  const configured = managed.data?.channels.filter(channel => channel.installationId === node.id) ?? [];
  const available = connections.filter(item => item.available && !configured.some(channel => channel.identity.teamId === item.identity?.teamId && channel.identity.botUserId === item.identity?.botUserId));
  async function request(command: RuntimeOperation) {
    if (busy) return;
    setBusy(true); setError(null);
    const serialized = JSON.stringify(command);
    if (intent.current?.input !== serialized) intent.current = { input: serialized, id: crypto.randomUUID() };
    try {
      const result = await sdk.operations.enqueue({ operationId: intent.current.id, installationId: node.id, command });
      cache.setQueryData(key("operation", result.id), result);
      if (command.kind === "channels.inspect") setInspection(result.id);
      else { setName(""); setConnection(""); await cache.invalidateQueries({ queryKey: key("channels") }); }
      intent.current = null;
    } catch { setError("Não foi possível confirmar o pedido. Consulte o estado abaixo antes de repetir. A mesma tentativa conserva sua identificação."); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-4 border-t border-line pt-4">
    <div><h4 className="font-medium">Canais desta instalação</h4><p className="mt-1 text-sm text-ink-2">O adapter continua rodando neste Ravi. As credenciais ficam no cofre da instalação; este Console recebe somente a identidade da conta e o resultado.</p></div>
    {managed.isPending && <p role="status" className="text-sm text-ink-2">Consultando canais…</p>}
    {managed.isError && <FormMessage>Não foi possível consultar os canais. <button className="underline" onClick={() => void managed.refetch()}>Tentar novamente</button></FormMessage>}
    {configured.map(channel => <div key={channel.id} className="space-y-2 rounded-md border border-line p-3">
      <p className="font-medium">{channel.name}</p><p className="text-sm text-ink-2" aria-live="polite">{labels[channel.status]} · {channel.enabled ? "Ativação solicitada" : "Desativação solicitada"}</p>
      <p className="break-all text-xs text-ink-2">Slack · {channel.identity.teamId} · {channel.identity.botUserId}</p>
      {channel.status === "succeeded" && <Button disabled={busy} onClick={() => void request({ kind: "channel.configure", provider: "slack", name: channel.name,
        credentialConnection: channel.credentialConnection, identity: channel.identity, enabled: !channel.enabled })}>{channel.enabled ? "Desativar canal" : "Ativar canal"}</Button>}
      {channel.status === "uncertain" && <p className="text-sm text-ink-2">A execução pode ter ocorrido. Não transfira a conexão; consulte o recibo e a instalação.</p>}
      {["failed","cancelled","uncertain"].includes(channel.status) && <Button onClick={() => void managed.refetch()}>Atualizar estado</Button>}
    </div>)}
    {!inspection ? <Button loading={busy} onClick={() => void request({ kind: "channels.inspect" })}>Consultar conexões disponíveis</Button>
      : inventory.isPending || inventory.data?.status === "queued" || inventory.data?.status === "delivered" ? <p role="status" className="text-sm text-ink-2">Consultando as conexões do Ravi…</p>
      : inventory.isError || inventory.data?.status !== "succeeded" ? <FormMessage>A consulta não foi confirmada. <button className="underline" onClick={() => void inventory.refetch()}>Consultar recibo</button></FormMessage>
      : !available.length ? <p className="text-sm text-ink-2">Nenhuma outra conexão Slack disponível. Você pode configurar uma credencial no cofre deste Ravi e consultar novamente. <button className="underline" onClick={() => setInspection(null)}>Nova consulta</button></p>
      : <form className="space-y-4" onSubmit={event => { event.preventDefault(); const selected = connections.find(item => item.connection === connection); if (selected?.identity) void request({ kind: "channel.configure", name, provider: "slack", credentialConnection: connection, identity: selected.identity, enabled: true }); }}>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Conta Slack</legend>{available.map(item => <label key={item.connection} className="flex items-start gap-2 text-sm"><input type="radio" name={`connection-${node.id}`} required value={item.connection} checked={connection === item.connection} disabled={busy} onChange={() => setConnection(item.connection)} /><span className="break-all">{item.connection} · {item.identity?.teamId} · {item.identity?.botUserId}</span></label>)}</fieldset>
        <Field label="Nome do canal no Ravi" hint="Use letras, números, hífen ou sublinhado.">{props => <Input {...props} name="channel-name" required pattern="[a-zA-Z0-9_-]{1,120}" maxLength={120} autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} />}</Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!connection || !name}>Configurar canal</Button>
      </form>}
    {error && <FormMessage>{error}</FormMessage>}
  </div>;
}
