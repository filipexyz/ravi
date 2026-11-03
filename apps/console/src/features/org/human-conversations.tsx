"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { withOrganizationParam } from "@/lib/api/organization";
import { useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { Field, Select, Textarea } from "@/ui/form";
import type { BridgeApproval, BridgeConversation, BridgeEvent, BridgeMessage, BridgeSnapshot, BridgeTurn } from "@/shared/human-bridge";

type ConversationInvocation={installationId:string;projectId:string;operationId:string;createdAt:number;command:string;input:Record<string,unknown>};
type Choice={installationId:string;projectId:string;installationName:string;projectName:string;agentIds:string[];canSend:boolean;canApprove:boolean};
class Rejected extends Error {constructor(readonly code:string,readonly effectState:"none"|"unknown"){super(code);}}
const active=(turn:BridgeTurn|null|undefined)=>Boolean(turn&&["queued","running","awaiting_approval"].includes(turn.status));
const labels:Record<string,string>={queued:"Mensagem recebida",running:"Ravi está trabalhando",awaiting_approval:"Uma ação precisa da sua decisão",completed:"Resposta concluída",failed:"A execução falhou",cancelled:"Execução cancelada",authorization_expired:"A autorização expirou. A execução foi interrompida.",interrupted_unknown:"A execução foi interrompida; alguns efeitos podem já ter ocorrido."};
function errorText(error:unknown){
  const code=error instanceof Rejected?error.code:error instanceof ApiError?error.code:"network_error";
  if(["bridge_access_denied","NOT_FOUND_OR_DENIED","INVALID_DELEGATION","auth_required"].includes(code))return "Seu acesso atual não permite continuar nesta conversa. Entre novamente ou consulte o administrador.";
  if(code==="VERSION_CONFLICT"||code==="TURN_BUSY")return "A conversa mudou. Confira o estado atualizado e tente novamente.";
  if(code==="APPROVAL_STALE")return "Essa decisão já não está disponível. Confira o estado da ação.";
  if(code==="REQUEST_EXPIRED")return "A tentativa expirou sem um novo envio. Confira o histórico antes de enviar novamente.";
  if(code==="PAYLOAD_TOO_LARGE")return "A mensagem ultrapassa o limite de tamanho. Reduza o texto e envie novamente.";
  return "Não foi possível confirmar a operação. Sua mensagem foi preservada.";
}

export function HumanConversations({subjectId}:{subjectId:string}){
  const {viewer,organization}=useWorkspace();
  const [choices,setChoices]=useState<Choice[]|null>(null),[choiceIndex,setChoiceIndex]=useState(0),[agentId,setAgentId]=useState("");
  const [conversations,setConversations]=useState<BridgeConversation[]>([]),[selected,setSelected]=useState<string|null>(null),[snapshot,setSnapshot]=useState<BridgeSnapshot|null>(null);
  const [text,setText]=useState(""),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const [connection,setConnection]=useState("Carregando"),[streamCursor,setStreamCursor]=useState<string|null>(null),[now,setNow]=useState(Date.now());
  const [pending,setPending]=useState<ConversationInvocation|null>(null);
  const [optionsAttempt,setOptionsAttempt]=useState(0);
  const generation=useRef(0),lastSequence=useRef(0),messageEnd=useRef<HTMLDivElement>(null);
  const choice=choices?.[choiceIndex];
  const request=(command:string,fields:Record<string,unknown>={}):ConversationInvocation=>({command:`sessions.conversations.${command}`,operationId:crypto.randomUUID(),createdAt:Date.now(),installationId:choice!.installationId,projectId:choice!.projectId,input:fields});
  async function call<T>(req:ConversationInvocation):Promise<T>{
    try {
      return await api.post<T>("/api/console/fleet/gateway/request",req);
    } catch(cause) {
      const e=cause instanceof ApiError && cause.status>0 && cause.status<500?new Rejected(cause.code,(cause.extra.body as {effectState?:"none"|"unknown"})?.effectState??"none"):cause;
      const code=e instanceof ApiError?e.code:e instanceof Rejected?e.code:"";
      if(["auth_required","bridge_access_denied","NOT_FOUND_OR_DENIED","ACCESS_REVOKED","INVALID_DELEGATION"].includes(code)){setSnapshot(null);setStreamCursor(null);}
      throw e;
    }
  }
  async function refresh(id=selected){
    const epoch=generation.current;
    const list=await call<BridgeConversation[]>(request("list"));
    if(epoch!==generation.current)return;
    setConversations(list);
    if(id){const value=await call<BridgeSnapshot>(request("open",{conversationId:id}));if(epoch===generation.current){setSnapshot(value);setStreamCursor(value.cursor);}}
  }
  useEffect(()=>{let disposed=false;generation.current++;lastSequence.current=0;setChoices(null);setChoiceIndex(0);setSelected(null);setSnapshot(null);setStreamCursor(null);setConversations([]);setText("");setPending(null);setError(null);api.get<{options:Choice[]}>("/api/console/fleet/gateway/options").then(result=>{if(!disposed){setChoices(result.options);setAgentId(result.options[0]?.agentIds[0]??"");}}).catch(e=>{if(!disposed)setError(errorText(e));});return()=>{disposed=true;};},[organization.id,subjectId,optionsAttempt]);
  useEffect(()=>{if(!choice)return;generation.current++;setSelected(null);setSnapshot(null);setStreamCursor(null);setText("");setError(null);setAgentId(choice.agentIds[0]??"");setLoading(true);void refresh(null).catch(e=>setError(errorText(e))).finally(()=>setLoading(false));},[choice?.installationId,choice?.projectId]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{messageEnd.current?.scrollIntoView({block:"nearest"});},[snapshot?.messages.length]);
  useEffect(()=>{
    if(!choice||!selected||!streamCursor)return;
    const params=new URLSearchParams({installationId:choice.installationId,projectId:choice.projectId,conversationId:selected,cursor:streamCursor});
    const stream=new EventSource(withOrganizationParam(`/api/console/fleet/gateway/stream?${params}`));let disposed=false;
    setConnection("Conectando");
    stream.addEventListener("journal",event=>{
      if(disposed)return;setConnection("Conectado");
      const batch=JSON.parse((event as MessageEvent).data) as {events:BridgeEvent[]};
      const events=batch.events.filter(e=>e.sequence>lastSequence.current);
      if(events.length)lastSequence.current=events.at(-1)!.sequence;
      setSnapshot(current=>{
        if(!current)return current;let next={...current};
        for(const event of events){
          if(event.type==="message.accepted"||event.type==="message.finalized"){
            const message=event.data as BridgeMessage;
            if(!next.messages.some(m=>m.id===message.id))next.messages=[...next.messages,message];
          } else if(event.type==="turn.state")next.turn=event.data as BridgeTurn;
          else if(event.type==="approval.opened")next.approvals=[...next.approvals.filter(a=>a.id!==(event.data as BridgeApproval).id),event.data as BridgeApproval];
          else if(event.type==="approval.state"){const value=event.data as Partial<BridgeApproval>;next.approvals=next.approvals.map(a=>a.id===value.id?{...a,...value}:a);}
          else if(event.type==="cancel.requested"&&next.turn)next.turn={...next.turn,cancelRequested:true};
        }
        return next;
      });
    });
    stream.addEventListener("gateway.error",event=>{
      const {code}=JSON.parse((event as MessageEvent).data);setConnection("Conexão interrompida");
      if(code==="RESYNC_REQUIRED"){stream.close();void refresh().catch(e=>setError(errorText(e)));}
      else if(["bridge_access_denied","auth_required","NOT_FOUND_OR_DENIED","INVALID_DELEGATION"].includes(code)){stream.close();setError(errorText(new Rejected(code,"none")));setSnapshot(null);}
    });
    stream.onerror=()=>{if(!disposed)setConnection("Reconectando — histórico preservado");};
    return()=>{disposed=true;stream.close();};
  },[selected,streamCursor,choice?.installationId,choice?.projectId]);
  useEffect(()=>{
    if(!choice?.canSend||!selected||!active(snapshot?.turn)||connection!=="Conectado")return;
    const timer=setInterval(()=>{void call(request("renew",{conversationId:selected})).catch(e=>{setError(errorText(e));setConnection("Autorização interrompida");});},8000);
    return()=>clearInterval(timer);
  },[selected,snapshot?.turn?.id,snapshot?.turn?.status,connection,choice?.canSend]);
  async function open(id:string){if(busy||pending)return;generation.current++;lastSequence.current=0;setSelected(id);setSnapshot(null);setStreamCursor(null);setLoading(true);setError(null);try{await refresh(id);}catch(e){setError(errorText(e));}finally{setLoading(false);}}
  async function mutate(req:ConversationInvocation){
    if(busy)return;setBusy(true);setError(null);setPending(req);
    try {
      const result=await call<{conversationId:string}>(req);
      setPending(null);
      if(req.command==="sessions.conversations.send")setText("");
      const id=result.conversationId??selected;
      if(id!==selected){lastSequence.current=0;setSelected(id);}
      await refresh(id);
    } catch(e){
      setError(errorText(e));
      if(e instanceof Rejected && e.effectState==="none"){setPending(null);await refresh().catch(()=>{});}
    } finally{setBusy(false);}
  }
  async function send(){
    if(!selected||!text.trim()||busy||pending||active(snapshot?.turn))return;
    // Refresh the current version before constructing an immutable send attempt.
    setBusy(true);
    let current:BridgeSnapshot;
    try{current=await call(request("open",{conversationId:selected}));setSnapshot(current);}catch(e){setError(errorText(e));setBusy(false);return;}
    setBusy(false);
    await mutate(request("send",{conversationId:selected,text,expectedVersion:current.conversation.version}));
  }
  const running=active(snapshot?.turn);
  return <div className="mx-auto max-w-6xl space-y-5">
    <header><h1 className="text-2xl font-semibold">Conversas com Ravi</h1><p className="mt-1 text-sm text-ink-2">{organization.name} · Você está como <strong className="text-ink">{viewer.name}</strong>. Suas conversas são privadas.</p></header>
    {error&&<div role="alert" className="rounded-lg border border-line bg-surface p-4 text-sm">{error}</div>}
    {pending&&<div className="rounded-lg border border-line bg-surface p-4 text-sm"><p>Esta tentativa ainda precisa de confirmação. Repeti-la consulta o mesmo recibo.</p><Button className="mt-3 min-h-11" disabled={busy} loading={busy} onClick={()=>void mutate(pending)}>Verificar tentativa</Button></div>}
    {!choices?(error?<Button className="min-h-11" onClick={()=>setOptionsAttempt(n=>n+1)}>Tentar carregar novamente</Button>:<p role="status">Carregando instalações disponíveis…</p>):!choices.length?<div className="rounded-lg border border-line bg-surface p-8"><h2 className="font-medium">Nenhuma instalação disponível</h2><p className="mt-2 text-sm text-ink-2">O administrador precisa vincular uma instalação e conceder seu acesso às conversas do projeto.</p></div>:<>
      <div className={selected?"hidden md:block":"block"}><Field label="Instalação e projeto">{props=><Select {...props} className="min-h-11" disabled={busy||Boolean(pending)} value={choiceIndex} onChange={e=>setChoiceIndex(Number(e.target.value))}>{choices.map((c,i)=><option key={`${c.installationId}:${c.projectId}`} value={i}>{c.installationName} · {c.projectName}</option>)}</Select>}</Field></div>
      <div className="grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
        <aside aria-label="Suas conversas" className={`${selected?"hidden md:block":"block"} space-y-4`}>
          <Field label="Agente">{props=><Select {...props} className="min-h-11" value={agentId} disabled={busy||Boolean(pending)} onChange={e=>setAgentId(e.target.value)}>{choice?.agentIds.map(id=><option key={id}>{id}</option>)}</Select>}</Field>
          <Button className="min-h-11 w-full" disabled={!choice?.canSend||busy||Boolean(pending)||!agentId} onClick={()=>void mutate(request("create",{agentId}))}>Nova conversa</Button>
          {loading&&!selected?<p role="status">Carregando conversas…</p>:<ul className="space-y-1">{conversations.map(c=><li key={c.id}><button className={`min-h-11 w-full rounded-md p-3 text-left text-sm hover:bg-hover ${selected===c.id?"bg-hover font-medium":""}`} aria-current={selected===c.id?"page":undefined} disabled={busy||Boolean(pending)} onClick={()=>void open(c.id)}>{c.title}<span className="block text-xs font-normal text-ink-2">{c.agentId} · {new Date(c.updatedAt).toLocaleDateString("pt-BR")}</span></button></li>)}</ul>}
        </aside>
        <section aria-label="Conversa" className={`${selected?"flex":"hidden md:flex"} min-w-0 flex-col rounded-lg border border-line bg-surface`}>
          {!selected?<p className="p-8 text-ink-2">Crie uma conversa ou escolha uma anterior.</p>:<>
            <div className="border-b border-line p-4"><Button className="mb-3 min-h-11 md:hidden" disabled={busy||Boolean(pending)} onClick={()=>{setSelected(null);setSnapshot(null);setStreamCursor(null);}}>← Conversas</Button><h2 className="font-medium">{snapshot?.conversation.agentId??"Ravi"} · {choice?.installationName}</h2><p className="mt-1 text-sm text-ink-2" aria-live="polite">{connection}</p></div>
            <div className="min-h-48 max-h-[55dvh] space-y-5 overflow-y-auto p-4 md:p-6">
              {loading?<p role="status">Abrindo conversa…</p>:snapshot?.messages.length?null:<p className="text-sm text-ink-2">O que você quer fazer com o Ravi?</p>}
              {snapshot?.hasOlder&&<Button className="min-h-11" disabled={busy} onClick={async()=>{setBusy(true);try{const older=await call<{messages:BridgeMessage[];hasOlder:boolean}>(request("history",{conversationId:selected,before:snapshot.messages[0]?.id}));setSnapshot(s=>s?{...s,messages:[...older.messages,...s.messages],hasOlder:older.hasOlder}:s);}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>Mensagens anteriores</Button>}
              {snapshot?.messages.map(m=><article key={m.id} className={m.role==="user"?"rounded-lg bg-hover p-4":"px-1"}><h3 className="mb-2 text-sm font-medium">{m.role==="user"?"Você":"Ravi"}</h3><div className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{m.text}</div></article>)}
              {snapshot?.approvals.filter(a=>a.turnId===snapshot.turn?.id).map(a=><div key={a.id} className="rounded-lg border border-line-strong p-4"><h3 className="font-medium">{a.state==="pending"?"Decisão necessária":"Decisão registrada"}</h3><pre className="my-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{a.description}</pre><p className="text-sm text-ink-2">{a.state==="pending"?(a.expiresAt<=now?"Expirada":"Esta aprovação vale somente para esta ação."):({approved:"Aprovada",rejected:"Recusada",expired:"Expirada",invalidated:"Encerrada"}[a.state])}</p>{a.state==="pending"&&running&&a.expiresAt>now&&choice?.canApprove&&<div className="mt-4 flex flex-wrap gap-2">{(["reject","approve"] as const).map(decision=><Button key={decision} className="min-h-11" variant={decision==="approve"?"primary":"secondary"} disabled={busy||Boolean(pending)||snapshot.turn?.cancelRequested} onClick={()=>void mutate(request("decide",{conversationId:selected,approvalId:a.id,decision,expectedVersion:a.version,actionDigest:a.actionDigest}))}>{decision==="approve"?"Aprovar esta ação":"Recusar"}</Button>)}</div>}</div>)}
              <div ref={messageEnd}/>
            </div>
            <div className="space-y-3 border-t border-line p-4">
              {snapshot?.turn&&<div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-sm text-ink-2">{snapshot.turn.cancelRequested&&running?"Cancelamento solicitado":labels[snapshot.turn.status]}</p>{running&&choice?.canSend&&<Button className="min-h-11" disabled={busy||Boolean(pending)||snapshot.turn.cancelRequested} onClick={()=>void mutate(request("cancel",{conversationId:selected,turnId:snapshot.turn!.id}))}>Cancelar execução</Button>}</div>}
              <form onSubmit={e=>{e.preventDefault();void send();}} className="space-y-3"><Field label="Mensagem para Ravi">{props=><Textarea {...props} rows={3} maxLength={16000} value={text} disabled={!choice?.canSend||Boolean(pending)} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>}</Field><div className="flex items-center justify-between gap-3"><span className="text-xs text-ink-2">Shift + Enter para nova linha</span><Button type="submit" variant="primary" className="min-h-11" loading={busy} disabled={busy||Boolean(pending)||running||!text.trim()||!choice?.canSend}>Enviar</Button></div></form>
            </div>
          </>}
        </section>
      </div>
    </>}
  </div>;
}
