// Orquestração: um agente coordenador divide o trabalho em frentes, dispara um subagente por frente,
// avalia cada entrega e pede outra rodada quando precisa. Tudo é deduzido do transcript real do
// coordenador, por um protocolo de texto simples (o da skill "orquestrar"):
//
//   [orquestração] Revisar a central                 -> começa uma orquestração (título)
//   Agent { description: "Frente 3: ADRs dos repos", model: "sonnet" }
//                                                    -> frente 3 entra (ou volta, numa nova rodada)
//   [avaliação] Frente 3: refazer — faltou a fonte   -> veredito do coordenador ("aprovado" ou "refazer")
//   [orquestração] concluída — 5 frentes aprovadas   -> fim
//
// Código puro (servidor e cliente). O estado guardado é uma lista de eventos; a visão é recalculada
// a partir dela, o que permite juntar o começo do arquivo lido depois (basta concatenar as listas).

import type { OrchestrationFront, OrchestrationInfo, OrchestrationLogEntry } from './types';
import { maskSecrets, truncate } from './activity';

export type OrchEvent =
  | { t: 'start'; at: number; title?: string }
  | { t: 'end'; at: number; summary?: string }
  | { t: 'spawn'; at: number; toolUseId: string; n: number; topic: string; model?: string }
  | { t: 'delivered'; at: number; toolUseId: string; error: boolean }
  | { t: 'verdict'; at: number; n: number; ok: boolean; reason?: string };

/** Quantos eventos o estado guarda (os mais recentes). */
export const MAX_ORCH_EVENTS = 300;
const MAX_LOG = 30;
const MAX_FRONTS = 12;

const SEP = String.raw`\s*[:\-–—]\s*`;
const FRONT_RE = new RegExp(String.raw`^\s*(?:frente|front)\s+(\d{1,2})${SEP}(.+?)\s*$`, 'i');
// Depois de "aprovado"/"refazer"/"concluída" vale qualquer texto ("aprovado com ressalva — ..."): o que vier
// vira o motivo (ou o resumo). Antes, um texto extra fazia a linha ser ignorada ou, pior, virar outro início.
const VERDICT_RE = new RegExp(String.raw`^\[(?:avalia(?:ção|cao)|review)\]\s*(?:frente|front)\s+(\d{1,2})${SEP}(aprovad[oa]|refazer|approved|redo)\b(.*)$`, 'i');
const ORCH_RE = /^\[(?:orquestra(?:ção|cao)|orchestration)\]\s*(.*?)\s*$/i;
const END_RE = /^(?:conclu[íi]d[ao]|encerrad[ao]|done|finished)\b(.*)$/i;
/** Pontuação e separadores entre a palavra-chave e o motivo. */
const LEAD_PUNCT = /^[\s:\-–—.,;!()]+/;
/** Comando de shell que só imprime uma marca: echo "[avaliação] ...". */
const ECHO_RE = /^\s*(?:echo|printf|Write-(?:Output|Host))\s+(?:-\w+\s+)*(["']?)(.*?)\1\s*;?\s*$/i;

function clean(s: string | undefined, n: number): string | undefined {
  const v = s?.trim();
  return v ? truncate(maskSecrets(v), n) : undefined;
}

/**
 * Tira o que um modelo costuma pôr em volta da marca: negrito e crases, e antes do "[" um prefixo sem letras
 * (lista "- " ou "1. ", título "### ", citação "> ", tabela "| ", emoji). A borda final de tabela também sai.
 */
function normalizeLine(raw: string): string {
  let line = raw.replace(/\*\*|__|`/g, '').trim();
  const i = line.indexOf('[');
  if (i > 0 && !/\p{L}/u.test(line.slice(0, i))) line = line.slice(i);
  return line.replace(/\s*\|\s*$/, '');
}

/** "Frente 3: ADRs dos repos" -> { n: 3, topic: "ADRs dos repos" }. */
export function parseFrontLabel(description: string | undefined): { n: number; topic: string } | undefined {
  const m = description ? FRONT_RE.exec(description) : null;
  if (!m) return undefined;
  const n = Number(m[1]);
  const topic = clean(m[2], 80);
  return n > 0 && topic ? { n, topic } : undefined;
}

/** Linhas de protocolo ([orquestração] e [avaliação]) num texto do coordenador. */
export function parseOrchestrationText(text: string, at: number): OrchEvent[] {
  if (!text.includes('[')) return [];
  const out: OrchEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (!line.startsWith('[')) continue;
    const v = VERDICT_RE.exec(line);
    if (v) {
      const n = Number(v[1]);
      const word = v[2].toLowerCase();
      const ok = word.startsWith('aprovad') || word === 'approved';
      const reason = clean(v[3].replace(LEAD_PUNCT, ''), 160);
      if (n > 0) out.push(reason ? { t: 'verdict', at, n, ok, reason } : { t: 'verdict', at, n, ok });
      continue;
    }
    const o = ORCH_RE.exec(line);
    if (o) {
      const rest = o[1];
      const end = END_RE.exec(rest);
      if (end) {
        const summary = clean(end[1].replace(LEAD_PUNCT, ''), 160);
        out.push(summary ? { t: 'end', at, summary } : { t: 'end', at });
      } else {
        const title = clean(rest, 100);
        out.push(title ? { t: 'start', at, title } : { t: 'start', at });
      }
    }
  }
  return out;
}

/**
 * Marcas emitidas por comando de shell (echo "[avaliação] Frente 2: aprovado — ok"). A entrada das ferramentas
 * fica no transcript exatamente como foi chamada, enquanto o texto da resposta pode ser gravado de outro jeito
 * (há versões do app que guardam só um resumo dele): é o canal confiável para o coordenador.
 */
export function parseOrchestrationCommand(command: string | undefined, at: number): OrchEvent[] {
  if (!command || !command.includes('[')) return [];
  const lines = command.split(/\r?\n|\s*(?:&&|;)\s*(?=(?:echo|printf|Write-)\b)/i).map((l) => ECHO_RE.exec(l)?.[2]);
  return parseOrchestrationText(lines.filter((l): l is string => !!l).join('\n'), at);
}

/** Acrescenta eventos mantendo só os mais recentes. */
export function pushOrchEvents(list: OrchEvent[], events: readonly OrchEvent[]): OrchEvent[] {
  if (!events.length) return list;
  const next = list.concat(events);
  return next.length > MAX_ORCH_EVENTS ? next.slice(next.length - MAX_ORCH_EVENTS) : next;
}

/**
 * Visão da orquestração mais recente. Uma orquestração começa num "[orquestração] título" ou, sem ele,
 * na primeira frente disparada depois do fim da anterior. Sem nenhuma frente, não há o que mostrar.
 */
export function buildOrchestration(
  events: readonly OrchEvent[],
  /** Modelo real do subagente de uma chamada (do transcript dele): vale mais que o apelido pedido na chamada. */
  modelOf?: (toolUseId: string) => string | undefined,
): OrchestrationInfo | undefined {
  type Cur = { info: OrchestrationInfo; byTool: Map<string, number>; current: Map<number, string>; fronts: Map<number, OrchestrationFront> };
  let cur: Cur | undefined;
  /** Orquestrações abertas, da mais antiga para a mais nova (a visão é a mais nova que tem frentes). */
  const all: Cur[] = [];
  const open = (at: number, title?: string) => {
    cur = { info: { startedAt: at, fronts: [], log: [] }, byTool: new Map(), current: new Map(), fronts: new Map() };
    if (title) cur.info.title = title;
    all.push(cur);
  };
  const log = (e: OrchestrationLogEntry) => {
    if (!cur) return;
    cur.info.log.push(e);
    if (cur.info.log.length > MAX_LOG) cur.info.log.shift();
  };

  for (const e of events) {
    switch (e.t) {
      case 'start':
        // Com uma orquestração aberta (sem fim) e já com frentes, um novo "[orquestração] título" só dá nome a
        // ela: o coordenador repete o título num resumo ou cita o protocolo, e isso não pode zerar o painel.
        if (cur && cur.info.endedAt === undefined && cur.fronts.size > 0) {
          if (e.title && !cur.info.title) cur.info.title = e.title;
          break;
        }
        if (cur && cur.info.endedAt === undefined && cur.fronts.size === 0) {
          if (e.title) cur.info.title = e.title;
          break;
        }
        open(e.at, e.title);
        log(e.title ? { at: e.at, kind: 'start', text: e.title } : { at: e.at, kind: 'start' });
        break;
      case 'spawn': {
        if (!cur || cur.info.endedAt !== undefined) open(e.at);
        const c = cur!;
        if (c.current.get(e.n) === e.toolUseId) break; // a mesma chamada lida de novo
        const prev = c.fronts.get(e.n);
        if (!prev && c.fronts.size >= MAX_FRONTS) break;
        const front: OrchestrationFront = { n: e.n, topic: e.topic, round: prev ? prev.round + 1 : 1, status: 'working', since: e.at };
        const model = modelOf?.(e.toolUseId) ?? e.model;
        if (model) front.model = model;
        c.fronts.set(e.n, front);
        c.byTool.set(e.toolUseId, e.n);
        c.current.set(e.n, e.toolUseId);
        log({ at: e.at, kind: 'spawn', n: e.n, round: front.round, text: e.topic });
        break;
      }
      case 'delivered': {
        // Só a chamada da rodada atual conta: a entrega atrasada de uma rodada anterior é ignorada.
        const n = cur?.byTool.get(e.toolUseId);
        const front = n !== undefined ? cur!.fronts.get(n) : undefined;
        if (!front || front.status !== 'working' || cur!.current.get(n!) !== e.toolUseId) break;
        front.status = e.error ? 'failed' : 'delivered';
        front.since = e.at;
        log({ at: e.at, kind: e.error ? 'failed' : 'delivered', n: front.n, round: front.round });
        break;
      }
      case 'verdict': {
        const front = cur?.fronts.get(e.n);
        if (!front) break;
        front.status = e.ok ? 'approved' : 'redo';
        front.since = e.at;
        if (e.reason) front.reason = e.reason;
        else delete front.reason;
        const entry: OrchestrationLogEntry = { at: e.at, kind: e.ok ? 'approved' : 'redo', n: front.n, round: front.round };
        if (e.reason) entry.text = e.reason;
        log(entry);
        break;
      }
      case 'end':
        if (!cur || cur.info.endedAt !== undefined) break;
        cur.info.endedAt = e.at;
        if (e.summary) cur.info.summary = e.summary;
        log(e.summary ? { at: e.at, kind: 'end', text: e.summary } : { at: e.at, kind: 'end' });
        break;
    }
  }
  // A mais nova com frentes: um "[orquestração] título" ainda sem frentes não apaga a anterior do painel.
  const found = [...all].reverse().find((c) => c.fronts.size > 0);
  if (!found) return undefined;
  found.info.fronts = [...found.fronts.values()].sort((a, b) => a.n - b.n);
  return found.info;
}

/** Contagem por situação (para o resumo "3 aprovadas · 1 refazer"). */
export function orchestrationCounts(o: OrchestrationInfo): Record<OrchestrationFront['status'], number> {
  const c = { working: 0, delivered: 0, approved: 0, redo: 0, failed: 0 };
  for (const f of o.fronts) c[f.status]++;
  return c;
}

/** Maior rodada entre as frentes. */
export function orchestrationRound(o: OrchestrationInfo): number {
  return o.fronts.reduce((m, f) => Math.max(m, f.round), 0);
}
