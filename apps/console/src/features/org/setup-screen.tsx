"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input } from "@/ui/form";
import { Panel } from "@/ui/layout";

const subscribeToReadiness = () => () => {};
const readClientReady = () => true;
const readServerReady = () => false;
const subscribeHash = (notify: () => void) => { window.addEventListener("hashchange", notify); return () => window.removeEventListener("hashchange", notify); };
const readSetupProof = () => new URLSearchParams(location.hash.slice(1)).get("setup") ?? "";
const readEmptyProof = () => "";

export function SetupScreen() {
  const ready = useSyncExternalStore(subscribeToReadiness, readClientReady, readServerReady);
  const search = useSearchParams(); const operation = useRef(crypto.randomUUID());
  const proof = useSyncExternalStore(subscribeHash, readSetupProof, readEmptyProof);
  const linkValid = /^[A-Za-z0-9_-]{43}$/.test(proof);
  const [manualToken, setToken] = useState(""), [busy, setBusy] = useState(false), [failed, setFailed] = useState(search.has("error"));
  const token = linkValid ? proof : manualToken;
  return <main data-fleet-private className="min-h-screen bg-canvas text-ink"><div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-5 py-10">
    <div className="space-y-2"><h1 className="text-2xl font-semibold">Primeiro acesso</h1><p className="text-sm text-ink-2">{linkValid ? "O instalador preparou este acesso. Confirme sua identidade para começar." : "Abra o link preparado pelo instalador ou use o código entregue pelo operador."}</p></div>
    <Panel padded><form className="space-y-4" aria-busy={!ready || busy} onSubmit={async event => {
      event.preventDefault(); if (!ready || busy) return; setBusy(true); setFailed(false);
      try {
        const response = await fetch("/api/setup/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, operationId: operation.current }) });
        if (!response.ok) throw new Error(); const result = await response.json() as { url: string }; setToken(""); history.replaceState(null, "", location.pathname); window.location.assign(result.url);
      } catch { setFailed(true); } finally { setBusy(false); }
    }}>{linkValid ? <p className="text-sm text-ink-2">Acesso preparado. O login confirma que você é a pessoa indicada para administrar este Console.</p> : <Field label="Código de configuração" hint="Uso único, com validade de 30 minutos. Não envie o código em chats.">{props => <Input {...props} type="password" required minLength={43} maxLength={43}
      autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={!ready || busy} value={token} onChange={event => { setToken(event.target.value.trim()); operation.current = crypto.randomUUID(); setFailed(false); }} />}</Field>}
      {failed && <FormMessage>Não foi possível validar o primeiro acesso. Confira o código, sua validade e a identidade esperada com o operador.</FormMessage>}
      <Button className="w-full" variant="primary" type="submit" loading={busy} disabled={!ready || busy || token.length !== 43}>{ready ? "Continuar para o login" : "Preparando formulário…"}</Button>
    </form></Panel><p className="text-sm text-ink-2">Já existe um administrador? Use o login normal. Esta página não recupera nem substitui uma organização existente.</p>
    <a className="text-sm underline underline-offset-4" href="/login">Voltar ao login</a>
  </div></main>;
}
