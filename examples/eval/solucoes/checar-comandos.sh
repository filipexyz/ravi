#!/usr/bin/env bash
# checar-comandos.sh — confere se todo `ravi ...` citado existe.
#
# Alvos aceitos:
#   - pasta de skills (varre *.md e *.txt, recursivo)
#   - arquivo .md ou .txt
#   - transcrição .jsonl (Claude ou Codex), ou o after.json / run.json de um `ravi eval run`
#
# Como confere (nessa ordem):
#   1. Estático, sem daemon: lê os @Group/@Command/@Option de <src>/src/cli/commands/*.ts
#      e os comandos de raiz de <src>/src/cli/index.ts. <src> vem de --src, de $RAVI_SRC
#      ou, sem os dois, do checkout que contém este script (três pastas acima).
#   2. Sem checkout e com `ravi` no PATH: `ravi <grupo> ... --help`, nível a nível.
#      Erro de rede ou de autenticação conta como "indeterminado", nunca como inexistente.
#
# Linha com "(novo)" ou "(new)" não reprova: o comando aparece como "novo".
# Linha que diz "não existe"/"inexistente" (exemplo de erro) também não: aparece como "citado-errado".
#
# Opções:
#   --src <dir>   checkout do ravi para a checagem estática
#   --help-mode   força a checagem por `ravi ... --help`
#   --ordem       só para transcrição: linha do tempo (skills abertas, comandos rodados,
#                 FICHA no texto) e os vereditos auxiliares de P1, P2 e N
#   --todos       lista também os comandos que existem
#   -h, --help    esta ajuda
#
# Saída: 0 = nada inexistente; 1 = algum comando ou flag inexistente; 2 = uso ou ambiente.

set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -eq 0 ]]; then
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  [[ $# -eq 0 ]] && exit 2 || exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "checar-comandos: precisa de python3" >&2
  exit 2
fi

# Raiz do checkout que contém o script (examples/eval/solucoes/ -> raiz).
CHECAR_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export CHECAR_REPO_ROOT

exec python3 -I - "$@" <<'PY'
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

# ---------------------------------------------------------------- argumentos
args = sys.argv[1:]
src = os.environ.get("RAVI_SRC", "")
help_mode = False
ordem = False
todos = False
alvos = []
i = 0
while i < len(args):
    a = args[i]
    if a == "--src":
        i += 1
        src = args[i] if i < len(args) else ""
    elif a == "--help-mode":
        help_mode = True
    elif a == "--ordem":
        ordem = True
    elif a == "--todos":
        todos = True
    elif a.startswith("-"):
        print(f"checar-comandos: opção desconhecida {a}", file=sys.stderr)
        sys.exit(2)
    else:
        alvos.append(a)
    i += 1

if not alvos:
    print("checar-comandos: diga ao menos um alvo (pasta, .md, .txt ou .jsonl)", file=sys.stderr)
    sys.exit(2)


def acha_src():
    if src:
        # --src ou $RAVI_SRC explícito: sem checkout ali é erro de uso, não troca de alvo
        return src if os.path.isdir(os.path.join(src, "src", "cli", "commands")) else None
    raiz = os.environ.get("CHECAR_REPO_ROOT", "")
    if raiz and os.path.isdir(os.path.join(raiz, "src", "cli", "commands")):
        return raiz
    return None


SRC = None if help_mode else acha_src()
if src and SRC is None and not help_mode:
    print(f"checar-comandos: {src} não é um checkout do ravi (falta src/cli/commands)", file=sys.stderr)
    sys.exit(2)
RAVI_BIN = shutil.which("ravi")
if SRC is None and RAVI_BIN is None:
    print("checar-comandos: sem checkout do ravi (--src) e sem `ravi` no PATH", file=sys.stderr)
    sys.exit(2)
if help_mode and RAVI_BIN is None:
    print("checar-comandos: --help-mode precisa de `ravi` no PATH", file=sys.stderr)
    sys.exit(2)

# ---------------------------------------------------------------- registro estático


class No:
    def __init__(self, nome):
        self.nome = nome
        self.filhos = {}      # nome -> No
        self.apelidos = {}    # apelido -> nome
        self.flags = set()
        self.comando = False  # tem ação própria
        self.tipo = None      # "read" | "mutate"

    def filho(self, tok):
        if tok in self.filhos:
            return self.filhos[tok]
        if tok in self.apelidos:
            return self.filhos[self.apelidos[tok]]
        if "/" in tok:
            # atalho de prosa: `ravi cron list/show` vale se todas as partes existem
            partes = [self.filho(p) for p in tok.split("/") if p]
            if partes and all(partes):
                return partes[0]
        return None

    def garante(self, nome):
        if nome not in self.filhos:
            self.filhos[nome] = No(nome)
        return self.filhos[nome]


def bloco(texto, ini):
    """Devolve o texto entre o '(' em ini e o ')' que fecha, respeitando aspas."""
    prof = 0
    j = ini
    aspas = None
    while j < len(texto):
        c = texto[j]
        if aspas:
            if c == "\\":
                j += 2
                continue
            if c == aspas:
                aspas = None
        elif c in "\"'`":
            aspas = c
        elif c in "([{":
            prof += 1
        elif c in ")]}":
            prof -= 1
            if prof == 0:
                return texto[ini + 1:j]
        j += 1
    return texto[ini + 1:]


RE_FLAG = re.compile(r"(?<![\w-])(--?[A-Za-z0-9][A-Za-z0-9-]*)")


def flags_de(spec):
    return set(m.group(1) for m in RE_FLAG.finditer(spec))


def str_campo(obj, campo):
    m = re.search(campo + r"\s*:\s*([\"'`])(.*?)\1", obj, re.S)
    return m.group(2) if m else None


def lista_campo(obj, campo):
    m = re.search(campo + r"\s*:\s*\[(.*?)\]", obj, re.S)
    if not m:
        return []
    return re.findall(r"[\"'`]([^\"'`]+)[\"'`]", m.group(1))


def constantes(texto):
    out = {}
    for m in re.finditer(r"\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*\{", texto):
        corpo = bloco(texto, m.end() - 1)
        f = str_campo(corpo, "flags")
        if f:
            out[m.group(1)] = f
    return out


def monta_registro(src):
    raiz = No("ravi")
    raiz.comando = True
    raiz.flags |= {"--version", "-V", "--help", "-h"}
    cmd_dir = os.path.join(src, "src", "cli", "commands")
    arquivos = sorted(
        os.path.join(cmd_dir, f) for f in os.listdir(cmd_dir)
        if f.endswith(".ts") and not f.endswith(".test.ts")
    )
    globais = {}
    textos = {}
    for arq in arquivos:
        t = open(arq, encoding="utf-8").read()
        textos[arq] = t
        globais.update(constantes(t))
    sem_resolver = 0
    for arq, t in textos.items():
        locais = dict(globais)
        locais.update(constantes(t))
        marcas = [(m.start(), m.group(1)) for m in re.finditer(r"@(Group|Command)\(", t)]
        grupo = None
        for k, (pos, tipo) in enumerate(marcas):
            fim = marcas[k + 1][0] if k + 1 < len(marcas) else len(t)
            obj = bloco(t, t.index("(", pos))
            nome = str_campo(obj, "name")
            if tipo == "Group":
                grupo = None
                if not nome or re.search(r"\bhidden\s*:\s*true", obj):
                    continue
                no = raiz
                partes = nome.split(".")
                for p in partes:
                    no = no.garante(p)
                for ap in lista_campo(obj, "aliases"):
                    pai = raiz
                    for p in partes[:-1]:
                        pai = pai.filhos[p]
                    pai.apelidos[ap] = partes[-1]
                grupo = no
                continue
            if grupo is None or not nome:
                continue
            no = grupo.garante(nome)
            no.comando = True
            for ap in lista_campo(obj, "aliases"):
                grupo.apelidos[ap] = nome
            trecho = t[pos:fim]
            ma = re.search(r"@CommandAccess\(\{[^}]*kind:\s*\"(read|mutate)\"", trecho)
            if ma:
                no.tipo = ma.group(1)
            for mo in re.finditer(r"@Option\(", trecho):
                arg = bloco(trecho, mo.end() - 1).strip()
                f = None
                if arg.startswith("{"):
                    f = str_campo(arg, "flags")
                    if not f:
                        ms = re.search(r"\.\.\.([A-Za-z_][A-Za-z0-9_]*)", arg)
                        f = locais.get(ms.group(1)) if ms else None
                else:
                    f = locais.get(arg)
                if f:
                    no.flags |= flags_de(f)
                else:
                    sem_resolver += 1
    # comandos de raiz registrados à mão em index.ts
    idx = os.path.join(src, "src", "cli", "index.ts")
    if os.path.exists(idx):
        t = open(idx, encoding="utf-8").read()
        for m in re.finditer(r"\.command\(\"([^\"]+)\"\)", t):
            nome = m.group(1).split()[0]
            no = raiz.garante(nome)
            no.comando = True
            fim = t.find(".command(", m.end())
            prox = t.find("\nprogram", m.end())
            corte = min(x for x in (fim, prox, len(t)) if x != -1)
            for mo in re.finditer(r"\.option\(\"([^\"]+)\"", t[m.end():corte]):
                no.flags |= flags_de(mo.group(1))
    return raiz, sem_resolver


# ---------------------------------------------------------------- registro por --help

_help_cache = {}


def roda_help(caminho):
    chave = tuple(caminho)
    if chave in _help_cache:
        return _help_cache[chave]
    try:
        p = subprocess.run([RAVI_BIN, *caminho, "--help"], capture_output=True, text=True, timeout=30)
        out = (p.stdout or "") + (p.stderr or "")
        ok = p.returncode == 0 and ("Usage:" in out or "Options:" in out)
    except Exception as e:  # noqa: BLE001
        out, ok = str(e), False
    _help_cache[chave] = (ok, out)
    return ok, out


def secao(texto, titulo):
    linhas = texto.splitlines()
    dentro = False
    out = []
    for ln in linhas:
        if ln.strip().startswith(titulo):
            dentro = True
            continue
        if dentro:
            if ln and not ln.startswith(" "):
                break
            out.append(ln)
    return out


def resolve_help(toks):
    """(status, caminho, detalhe, flags_validas)"""
    caminho = []
    for tok in toks:
        if tok.startswith("-") or eh_marcador(tok):
            break
        ok, out = roda_help(caminho)
        if not ok:
            ult = out.strip().splitlines()
            return "indeterminado", caminho, (ult[-1] if ult else "sem saída"), None
        cmds = set()
        for ln in secao(out, "Commands:"):
            w = ln.strip().split(" ")[0] if ln.strip() else ""
            for parte in w.split("|"):
                if parte:
                    cmds.add(parte)
        if not cmds:
            break
        if tok not in cmds:
            return "inexistente", caminho, f"'{tok}' não é subcomando de 'ravi {' '.join(caminho)}'", None
        caminho.append(tok)
    ok, out = roda_help(caminho)
    if not ok:
        return "indeterminado", caminho, "sem --help legível (rede, autenticação ou binário)", None
    fl = set()
    for ln in secao(out, "Options:"):
        fl |= flags_de(ln.split("  ")[1] if ln.startswith("  ") and len(ln.split("  ")) > 1 else ln)
    fl |= {"--help", "-h"}
    return "ok", caminho, "", fl


# ---------------------------------------------------------------- extração

RE_SPAN = re.compile(r"`([^`\n]+)`")
MARCA_NOVO = re.compile(r"\((novo|new)\)", re.I)
# a linha diz que o comando não existe (exemplo de erro, anti-padrão): não reprova
MARCA_INEXISTE = re.compile(r"não existe|não existem|inexistente|nonexistent|does not exist", re.I)


def eh_marcador(tok):
    t = tok.strip()
    return (not t) or t[0] in "<{[$…" or t in ("...", "…", "-", "—") or t.endswith(">")


def segmentos(linha):
    """Corta em | || && ; fora de aspas e de <...>."""
    out, atual, aspas, ang = [], [], None, 0
    j = 0
    while j < len(linha):
        c = linha[j]
        if aspas:
            atual.append(c)
            if c == "\\" and j + 1 < len(linha):
                atual.append(linha[j + 1])
                j += 2
                continue
            if c == aspas:
                aspas = None
        elif c in "\"'":
            aspas = c
            atual.append(c)
        elif c == "<" and j + 1 < len(linha) and linha[j + 1] not in " <=":
            ang += 1
            atual.append(c)
        elif c == ">" and ang > 0:
            ang -= 1
            atual.append(c)
        elif ang == 0 and c in "|;&":
            out.append("".join(atual))
            atual = []
            while j + 1 < len(linha) and linha[j + 1] in "|&":
                j += 1
        else:
            atual.append(c)
        j += 1
    out.append("".join(atual))
    return out


def tokens(seg):
    try:
        return shlex.split(seg, posix=True)
    except ValueError:
        return seg.split()


def comandos_da_linha(linha):
    """Lista de listas de tokens depois de `ravi`."""
    achados = []
    for seg in segmentos(linha):
        tk = tokens(seg.strip())
        for k, t in enumerate(tk):
            limpo = t.lstrip("$(`")
            if limpo == "ravi" or limpo.endswith("/ravi"):
                antes = tk[:k]
                if all(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", x) or x in ("$", "time", "env", "exec") for x in antes):
                    achados.append(tk[k + 1:])
                break
    return achados


def extrai_texto(conteudo, origem):
    """Comandos citados em blocos de código (linhas) e em `spans` de markdown."""
    out = []
    linhas = conteudo.splitlines()
    em_bloco = False
    acum, ini = "", 0
    for n, ln in enumerate(linhas, 1):
        s = ln.strip()
        if s.startswith("```") or s.startswith("~~~"):
            em_bloco = not em_bloco
            continue
        if em_bloco:
            if acum:
                acum += " " + s
            else:
                acum, ini = s, n
            if acum.endswith("\\"):
                acum = acum[:-1]
                continue
            linha_cmd = re.sub(r"^\$\s+", "", acum)
            linha_sem_coment = re.sub(r"\s#\s.*$", "", linha_cmd)
            novo = "novo" if MARCA_NOVO.search(acum) else ("citado" if MARCA_INEXISTE.search(acum) else "")
            if re.match(r"^(\S+=\S+\s+)*(\./)?(bin/)?ravi\s", linha_sem_coment) or re.search(r"(&&|\|\||;|\|)\s*ravi\s", linha_sem_coment):
                for tk in comandos_da_linha(linha_sem_coment):
                    out.append((origem, ini, tk, novo, "texto"))
            else:
                # linha de bloco que não é comando (ex.: FICHA): confere os `spans` com ravi
                for m in RE_SPAN.finditer(acum):
                    span = m.group(1).strip()
                    if re.match(r"^(\$\s+)?ravi\s", span):
                        for tk in comandos_da_linha(re.sub(r"^\$\s+", "", span)):
                            out.append((origem, ini, tk, novo, "texto"))
            acum = ""
            continue
        for m in RE_SPAN.finditer(ln):
            span = m.group(1).strip()
            if re.match(r"^(\$\s+)?ravi\s", span):
                novo = "novo" if MARCA_NOVO.search(ln) else ("citado" if MARCA_INEXISTE.search(ln) else "")
                for tk in comandos_da_linha(re.sub(r"^\$\s+", "", span)):
                    out.append((origem, n, tk, novo, "texto"))
    return out


def comandos_de_shell(cmd):
    out = []
    for ln in re.split(r"\n", cmd.replace("\\\n", " ")):
        out += comandos_da_linha(ln.strip())
    return out


def le_transcricao(caminho):
    """Eventos em ordem: ("skill", nome) | ("exec", tokens, texto) | ("texto", str)."""
    eventos = []

    def de_bash(cmd, n):
        for tk in comandos_de_shell(cmd):
            eventos.append(("exec", tk, cmd, n))

    with open(caminho, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if e.get("type") == "assistant":
                cont = (e.get("message") or {}).get("content")
                partes = cont if isinstance(cont, list) else [{"type": "text", "text": cont or ""}]
                for p in partes:
                    if not isinstance(p, dict):
                        continue
                    if p.get("type") == "text" and p.get("text"):
                        eventos.append(("texto", p["text"], n))
                    elif p.get("type") == "tool_use":
                        inp = p.get("input") or {}
                        if p.get("name") == "Skill":
                            eventos.append(("skill", str(inp.get("skill") or inp.get("name") or ""), n))
                        cmd = inp.get("command") or inp.get("cmd")
                        if isinstance(cmd, list):
                            cmd = " ".join(cmd)
                        if isinstance(cmd, str):
                            de_bash(cmd, n)
            elif e.get("type") == "response_item":
                pl = e.get("payload") or {}
                if pl.get("type") == "message" and pl.get("role") == "assistant":
                    for p in pl.get("content") or []:
                        if isinstance(p, dict) and p.get("text"):
                            eventos.append(("texto", p["text"], n))
                elif pl.get("type") in ("function_call", "local_shell_call", "custom_tool_call"):
                    argsj = pl.get("arguments") or pl.get("input") or pl.get("action") or {}
                    if isinstance(argsj, str):
                        try:
                            argsj = json.loads(argsj)
                        except json.JSONDecodeError:
                            argsj = {"command": argsj}
                    cmd = argsj.get("command") or argsj.get("cmd") if isinstance(argsj, dict) else None
                    if isinstance(cmd, list):
                        cmd = cmd[-1] if len(cmd) >= 3 and cmd[1] in ("-lc", "-c") else " ".join(cmd)
                    if isinstance(cmd, str):
                        de_bash(cmd, n)
    return eventos


def resolve_alvo(a):
    if a.endswith(".json") and os.path.isfile(a):
        try:
            d = json.load(open(a, encoding="utf-8"))
        except json.JSONDecodeError:
            return a
        for chave in (("after", "transcript", "path"), ("transcript", "path")):
            x = d
            for c in chave:
                x = x.get(c) if isinstance(x, dict) else None
            if isinstance(x, str) and x:
                return x
    return a


# ---------------------------------------------------------------- checagem

if SRC:
    RAIZ, SEM_RESOLVER = monta_registro(SRC)
else:
    RAIZ, SEM_RESOLVER = None, 0


def checa(tk):
    """(status, caminho_str, detalhe, tipo) com status ok|inexistente|flag|marcador|indeterminado."""
    if not tk or eh_marcador(tk[0]):
        return "marcador", "", "comando genérico", None
    if RAIZ is None:
        st, caminho, det, fl = resolve_help(tk)
        if st != "ok":
            return st, " ".join(caminho), det, None
        ruins = [t.split("=")[0] for t in tk if t.startswith("-") and not re.match(r"^-\d", t) and t != "--" and t.split("=")[0] not in fl]
        if ruins:
            return "flag", " ".join(caminho), "flag inexistente: " + ", ".join(sorted(set(ruins))), None
        return "ok", " ".join(caminho), "", None
    no, caminho, linhagem = RAIZ, [], [RAIZ]
    k = 0
    while k < len(tk):
        t = tk[k]
        if t.startswith("-"):
            break
        f = no.filho(t)
        if f is None:
            break
        no = f
        caminho.append(f.nome)
        linhagem.append(no)
        k += 1
    resto = tk[k:]
    pos = [t for t in resto if not t.startswith("-")]
    if no is RAIZ:
        if pos and eh_marcador(pos[0]):
            return "marcador", "", "comando genérico", None
        if pos:
            return "inexistente", "", f"grupo '{pos[0]}' não existe", None
    if not no.comando and no is not RAIZ:
        if resto and resto[0] == "help":
            return "ok", " ".join(caminho + ["help"]), "", None  # help implícito do commander
        if pos and not eh_marcador(pos[0]) and not resto[0].startswith("-"):
            subs = ", ".join(sorted(no.filhos)[:12])
            return "inexistente", " ".join(caminho), f"'{pos[0]}' não é subcomando de 'ravi {' '.join(caminho)}' (tem: {subs})", None
    validas = {"--help", "-h"}
    for x in linhagem:
        validas |= x.flags
    ruins = []
    for t in resto:
        if not t.startswith("-") or t == "--" or re.match(r"^-\d", t) or t in ("-", "--…", "--..."):
            continue
        nome = t.split("=")[0]
        if nome not in validas:
            ruins.append(nome)
    if ruins:
        return "flag", " ".join(caminho), "flag inexistente em 'ravi " + " ".join(caminho) + "': " + ", ".join(sorted(set(ruins))), no.tipo
    return "ok", " ".join(caminho), "", no.tipo


def coleta(alvo):
    alvo = resolve_alvo(alvo)
    if os.path.isdir(alvo):
        out = []
        for base, _dirs, arqs in os.walk(alvo):
            for f in sorted(arqs):
                if f.endswith((".md", ".txt")):
                    p = os.path.join(base, f)
                    out += extrai_texto(open(p, encoding="utf-8").read(), p)
        return out, None
    if alvo.endswith(".jsonl"):
        ev = le_transcricao(alvo)
        out = []
        for e in ev:
            if e[0] == "exec":
                out.append((alvo, e[3], e[1], "", "exec"))
            elif e[0] == "texto":
                for o in extrai_texto(e[1], alvo):
                    out.append((alvo, e[2], o[2], o[3], "texto"))
        return out, ev
    if os.path.isfile(alvo):
        return extrai_texto(open(alvo, encoding="utf-8").read(), alvo), None
    print(f"checar-comandos: alvo não encontrado: {alvo}", file=sys.stderr)
    sys.exit(2)


GRUPOS_P1 = {"bases", "pages", "triggers", "cron"}
# aceitam --execute mas agem sem ele (AGENTS.md: "`ship` executes immediately")
IMEDIATOS = {"pages ship"}


def linha_do_tempo(ev):
    print("\n== Linha do tempo (só o que o agente fez; a saída das ferramentas não entra)")
    abriu = None
    primeiro_grupo = None
    primeira_mut = None
    primeira_ficha = None
    for idx, e in enumerate(ev):
        if e[0] == "skill":
            print(f"  [{idx:03}] skill   {e[1]}")
            if "solucoes" in e[1] and abriu is None:
                abriu = idx
        elif e[0] == "exec":
            tk = e[1]
            st, cam, det, tipo = checa(tk)
            txt = "ravi " + " ".join(tk)
            if len(txt) > 110:
                txt = txt[:107] + "..."
            mut = tipo == "mutate" and ("--execute" in tk or not tem_execute(cam) or cam in IMEDIATOS)
            print(f"  [{idx:03}] exec    {txt}" + ("   <- mutação" if mut else ""))
            if cam.startswith("skills show") and any("solucoes" in t for t in tk) and abriu is None:
                abriu = idx
            if cam.split(" ")[0] in GRUPOS_P1 and primeiro_grupo is None:
                primeiro_grupo = idx
            if mut and primeira_mut is None:
                primeira_mut = idx
        elif e[0] == "texto" and "FICHA" in e[1]:
            print(f"  [{idx:03}] texto   (contém FICHA)")
            if primeira_ficha is None:
                primeira_ficha = idx
    print("\n== Vereditos auxiliares (o juiz decide; isto só aponta)")
    if abriu is None:
        print("  P1: falha — solucoes não foi aberta (nem `ravi skills show solucoes`, nem a ferramenta Skill)")
    elif primeiro_grupo is not None and primeiro_grupo < abriu:
        print(f"  P1: falha — um comando de bases/pages/triggers/cron veio antes ([{primeiro_grupo:03}] < [{abriu:03}])")
    else:
        print(f"  P1: passa — solucoes aberta em [{abriu:03}]")
    if primeira_mut is None:
        print("  P2: sem mutação no turno" + (" — FICHA mostrada" if primeira_ficha is not None else " — sem FICHA no texto"))
    elif primeira_ficha is not None and primeira_ficha < primeira_mut:
        print(f"  P2: passa — FICHA em [{primeira_ficha:03}] antes da 1ª mutação em [{primeira_mut:03}]")
    else:
        print(f"  P2: falha — 1ª mutação em [{primeira_mut:03}] sem FICHA antes (ou plano equivalente: o juiz confere)")
    print("  N (só negativos): " + ("falha — houve FICHA" if primeira_ficha is not None else "passa — sem FICHA")
          + ("; abriu solucoes" if abriu is not None else ""))


_tem_exec = {}


def tem_execute(caminho):
    if RAIZ is None or not caminho:
        return False
    if caminho in _tem_exec:
        return _tem_exec[caminho]
    no = RAIZ
    for p in caminho.split(" "):
        no = no.filhos.get(p) or no
    _tem_exec[caminho] = "--execute" in no.flags
    return _tem_exec[caminho]


# ---------------------------------------------------------------- principal

total = {"ok": 0, "inexistente": 0, "flag": 0, "novo": 0, "citado": 0, "marcador": 0, "indeterminado": 0}
falhas = []
vistos = set()
eventos_transcricao = []
for alvo in alvos:
    achados, ev = coleta(alvo)
    if ev is not None:
        eventos_transcricao.append((alvo, ev))
    for origem, linha, tk, novo, fonte in achados:
        chave = (origem, linha, tuple(tk))
        if chave in vistos:
            continue
        vistos.add(chave)
        st, cam, det, _tipo = checa(tk)
        if st in ("inexistente", "flag") and novo:
            st = novo
        total[st] += 1
        txt = "ravi " + " ".join(tk)
        if len(txt) > 120:
            txt = txt[:117] + "..."
        rotulo = {"ok": "ok", "inexistente": "INEXISTENTE", "flag": "FLAG", "novo": "novo",
                  "citado": "citado-errado", "marcador": "genérico", "indeterminado": "indeterminado"}[st]
        if st in ("inexistente", "flag", "indeterminado", "novo", "citado") or todos:
            falhas.append((st, f"{rotulo:13} {origem}:{linha} [{fonte}]  {txt}" + (f"\n{'':14}→ {det}" if det else "")))

modo = f"estático em {SRC}" if RAIZ is not None else f"--help de {RAVI_BIN}"
print(f"checar-comandos ({modo})")
if RAIZ is not None and SEM_RESOLVER:
    print(f"  aviso: {SEM_RESOLVER} @Option sem flag literal resolvida no código (flags dessas opções podem sair como inexistentes)")
ordem_st = {"inexistente": 0, "flag": 1, "indeterminado": 2, "novo": 3, "citado": 4, "ok": 5, "marcador": 6}
for st, msg in sorted(falhas, key=lambda x: ordem_st[x[0]]):
    print(msg)
print(
    f"\nResumo: {total['ok']} ok · {total['inexistente']} comando inexistente · {total['flag']} flag inexistente · "
    f"{total['novo']} marcado (novo) · {total['citado']} citado como inexistente · "
    f"{total['indeterminado']} indeterminado · {total['marcador']} genérico"
)

if ordem:
    if not eventos_transcricao:
        print("\n--ordem só vale para transcrição (.jsonl, after.json ou run.json)")
    for alvo, ev in eventos_transcricao:
        print(f"\n### {alvo}")
        linha_do_tempo(ev)

sys.exit(1 if total["inexistente"] or total["flag"] else 0)
PY
