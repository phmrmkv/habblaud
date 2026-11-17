// Seção "Orquestração" da gaveta do agente: o coordenador dividiu o trabalho em frentes (um subagente por
// frente), avaliou cada entrega e pode ter pedido outra rodada. Os dados vêm de AgentInfo.orchestration,
// montado no servidor a partir do transcript (shared/orchestration.ts).
import type { AgentInfo, AgentStats, OrchestrationFront, OrchestrationInfo, OrchestrationLogEntry, OrchestrationStatus, OrchestrationSummary } from '../../../shared/types';
import { orchestrationCounts, orchestrationRound, parseFrontLabel } from '../../../shared/orchestration';
import { tr } from '../../../shared/i18n';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatClock, formatTokens, formatUSD, plural, prettyModel, relativeTime } from './format';

const LOG_SHOWN = 6;

/** "claude-sonnet-5-5" -> "Sonnet 5.5"; o apelido pedido na chamada ("sonnet") -> "Sonnet". */
function modelName(model: string): string {
  const pretty = prettyModel(model);
  return pretty === model ? model.charAt(0).toUpperCase() + model.slice(1) : pretty;
}

function statusLabel(s: OrchestrationStatus): string {
  switch (s) {
    case 'working':
      return tr('trabalhando');
    case 'delivered':
      return tr('entregou, em avaliação');
    case 'approved':
      return tr('aprovado');
    case 'redo':
      return tr('refazer');
    case 'failed':
      return tr('falhou');
  }
}

function phaseOf(o: OrchestrationInfo): { key: string; label: string } {
  if (o.endedAt !== undefined) return { key: 'done', label: tr('concluída') };
  const c = orchestrationCounts(o);
  if (c.delivered > 0 || c.failed > 0) return { key: 'review', label: tr('avaliando entregas') };
  if (c.working > 0) return { key: 'wait', label: tr('aguardando entregas') };
  return { key: 'decide', label: tr('decidindo o próximo passo') };
}

function countsText(o: OrchestrationInfo): string {
  const c = orchestrationCounts(o);
  const parts: string[] = [];
  if (c.approved) parts.push(plural(c.approved, tr('aprovada'), tr('aprovadas')));
  if (c.redo) parts.push(tr('{0} para refazer', [c.redo]));
  if (c.delivered) parts.push(tr('{0} em avaliação', [c.delivered]));
  if (c.working) parts.push(tr('{0} trabalhando', [c.working]));
  if (c.failed) parts.push(tr('{0} com falha', [c.failed]));
  return parts.join(' · ');
}

function logText(e: OrchestrationLogEntry): string {
  const f = e.n !== undefined ? tr('Frente {0}', [e.n]) : '';
  switch (e.kind) {
    case 'start':
      return e.text ? tr('Começou: {0}', [e.text]) : tr('Começou a orquestração');
    case 'spawn':
      return (e.round ?? 1) > 1 ? tr('{0} voltou para a rodada {1}', [f, e.round]) : tr('{0} disparada: {1}', [f, e.text ?? '']);
    case 'delivered':
      return tr('{0} entregou', [f]);
    case 'failed':
      return tr('{0} falhou', [f]);
    case 'approved':
      return e.text ? tr('{0} aprovada: {1}', [f, e.text]) : tr('{0} aprovada', [f]);
    case 'redo':
      return e.text ? tr('{0} para refazer: {1}', [f, e.text]) : tr('{0} para refazer', [f]);
    case 'end':
      return e.text ? tr('Concluída: {0}', [e.text]) : tr('Orquestração concluída');
  }
}

/** "120 k tokens · US$ 0,12" (o custo só entra quando existe). */
function costText(s: Pick<AgentStats, 'tokensIn' | 'tokensOut' | 'costUSD'>): string {
  const tokens = tr('{0} tokens', [formatTokens(s.tokensIn + s.tokensOut)]);
  return s.costUSD !== undefined ? `${tokens} · ${formatUSD(s.costUSD)}` : tokens;
}

/** "3 frentes · 2 aprovadas · 1 refeita" */
function summaryCounts(p: OrchestrationSummary): string {
  return [plural(p.fronts, tr('frente'), tr('frentes')), plural(p.approved, tr('aprovada'), tr('aprovadas')), plural(p.redo, tr('refeita'), tr('refeitas'))].join(' · ');
}

interface PrevRow extends HTMLElement {
  _title: HTMLElement;
  _when: HTMLElement;
  _counts: HTMLElement;
}

interface FrontRow extends HTMLElement {
  _num: HTMLElement;
  _topic: HTMLElement;
  _meta: HTMLElement;
  _cost: HTMLElement;
  _pill: HTMLElement;
  _reason: HTMLElement;
  _agentId?: string;
}

export class OrchestrationSection {
  readonly el: HTMLElement;
  private extra: HTMLElement;
  private heading: HTMLElement;
  private phase: HTMLElement;
  private counts: HTMLElement;
  private strip: HTMLElement;
  private fronts: KeyedList<OrchestrationFront, FrontRow>;
  private log: KeyedList<OrchestrationLogEntry & { key: string }>;
  private summary: HTMLElement;
  private subs = new Map<number, string>();
  private subStats = new Map<number, AgentStats>();
  private total: HTMLElement;
  private prevBox: HTMLDetailsElement;
  private prevTitle: HTMLElement;
  private prev: KeyedList<OrchestrationSummary, PrevRow>;
  private now = Date.now();

  constructor(private readonly ctx: UiContext) {
    const title = h('h3', { class: 'ui-sec__title', text: tr('Orquestração') });
    this.extra = h('span', { class: 'ui-sec__extra' });
    this.heading = h('p', { class: 'ui-orch__title' });
    this.phase = h('span', { class: 'ui-orch__phase' });
    this.counts = h('p', { class: 'ui-orch__counts' });
    this.total = h('p', { class: 'ui-orch__total', hidden: true });
    this.strip = h('div', { class: 'ui-orch__strip', attrs: { 'aria-hidden': 'true' } });
    this.prevTitle = h('summary', { class: 'ui-orch__prevsum' });
    const prevList = h('ul', { class: 'ui-orch__prevlist' });
    this.prevBox = h('details', { class: 'ui-orch__prev', hidden: true }, this.prevTitle, prevList);
    this.prev = new KeyedList<OrchestrationSummary, PrevRow>(prevList, {
      key: (p) => String(p.startedAt),
      create: () => {
        const title = h('span', { class: 'ui-orch__prevtitle' });
        const when = h('span', { class: 'ui-orch__prevwhen' });
        const counts = h('span', { class: 'ui-orch__prevcounts' });
        const li = h('li', { class: 'ui-orch__previtem' }, h('span', { class: 'ui-orch__prevtop' }, title, when), counts) as unknown as PrevRow;
        li._title = title;
        li._when = when;
        li._counts = counts;
        return li;
      },
      update: (li, p) => {
        const label = p.title ?? plural(p.fronts, tr('frente em paralelo'), tr('frentes em paralelo'));
        setText(li._title, label);
        setTitle(li._title, p.summary ? `${label} — ${p.summary}` : label);
        setText(li._when, relativeTime(p.startedAt, this.now));
        setText(li._counts, summaryCounts(p));
      },
      animate: false,
    });
    this.summary = h('p', { class: 'ui-orch__summary', hidden: true });
    const list = h('ul', { class: 'ui-orch__fronts' });
    const logList = h('ol', { class: 'ui-orch__log' });
    this.fronts = new KeyedList<OrchestrationFront, FrontRow>(list, {
      key: (f) => String(f.n),
      create: () => this.createRow(),
      update: (row, f) => this.updateRow(row, f),
    });
    this.log = new KeyedList<OrchestrationLogEntry & { key: string }>(logList, {
      key: (e) => e.key,
      create: (e) => h('li', { class: 'ui-orch__logitem' }, h('time', { text: formatClock(e.at, false) }), h('span', { text: logText(e) })),
      update: () => undefined,
      animate: false,
    });
    this.el = h(
      'section',
      { class: 'ui-sec ui-orch', hidden: true },
      h('div', { class: 'ui-sec__head' }, title, this.extra),
      h('div', { class: 'ui-orch__lead' }, h('div', { class: 'ui-orch__leadtop' }, this.heading, this.phase), this.counts, this.total, this.strip),
      list,
      this.summary,
      logList,
      this.prevBox,
    );
  }

  clear(): void {
    this.fronts.clear();
    this.log.clear();
    this.prev.clear();
    this.subs.clear();
    this.subStats.clear();
  }

  render(a: AgentInfo, agents: readonly AgentInfo[] | undefined, now: number): void {
    const o = a.kind === 'main' ? a.orchestration : undefined;
    setHidden(this.el, !o);
    if (!o) return;

    // Subagente ainda no escritório para cada frente: o que começou por último (rodada mais recente).
    this.now = now;
    this.subs.clear();
    this.subStats.clear();
    const startedAt = new Map<number, number>();
    for (const s of agents ?? []) {
      if (s.parentId !== a.id) continue;
      const f = parseFrontLabel(s.title);
      if (!f || (startedAt.get(f.n) ?? -Infinity) > s.startedAt) continue;
      startedAt.set(f.n, s.startedAt);
      this.subs.set(f.n, s.id);
      this.subStats.set(f.n, s.stats);
    }

    // Total das frentes que têm subagente ligado (sem ele, não há o que somar).
    let tokens = 0;
    let cost = 0;
    let hasCost = false;
    for (const f of o.fronts) {
      const st = this.subStats.get(f.n);
      if (!st) continue;
      tokens += st.tokensIn + st.tokensOut;
      if (st.costUSD !== undefined) {
        cost += st.costUSD;
        hasCost = true;
      }
    }
    const linked = this.subStats.size > 0 && o.fronts.some((f) => this.subStats.has(f.n));
    setHidden(this.total, !linked);
    setText(this.total, linked ? tr('Frentes: {0}', [costText({ tokensIn: tokens, tokensOut: 0, ...(hasCost ? { costUSD: cost } : {}) })]) : '');

    const previous = o.previous ?? [];
    setHidden(this.prevBox, previous.length === 0);
    setText(this.prevTitle, tr('Anteriores ({0})', [previous.length]));
    this.prev.sync(previous);

    const round = orchestrationRound(o);
    setText(this.extra, round > 1 ? tr('rodada {0}', [round]) : relativeTime(o.startedAt, now));
    setText(this.heading, o.title ?? plural(o.fronts.length, tr('frente em paralelo'), tr('frentes em paralelo')));
    setTitle(this.heading, o.title ?? '');
    const phase = phaseOf(o);
    setText(this.phase, phase.label);
    setVariant(this.phase, 'is-', phase.key);
    setText(this.counts, tr('Coordenador {0} · {1}', [prettyModel(a.model), countsText(o)]));

    // Faixa: um bloco por frente, na cor da situação.
    const blocks = this.strip.children;
    while (blocks.length > o.fronts.length) blocks[blocks.length - 1].remove();
    o.fronts.forEach((f, i) => {
      const b = (blocks[i] as HTMLElement | undefined) ?? this.strip.appendChild(h('span', { class: 'ui-orch__block' }));
      setVariant(b, 'is-', f.status);
    });

    this.fronts.sync(o.fronts);
    setHidden(this.summary, !o.summary);
    setText(this.summary, o.summary ?? '');
    // Chave estável: o próprio evento (e um contador só para eventos idênticos), nunca a posição na lista.
    const seen = new Map<string, number>();
    const items = o.log.slice(-LOG_SHOWN).map((e) => {
      const base = `${e.at}:${e.kind}:${e.n ?? ''}:${e.round ?? ''}`;
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      return { ...e, key: `${base}:${k}` };
    });
    this.log.sync(items.reverse());
  }

  private createRow(): FrontRow {
    const num = h('span', { class: 'ui-orch__num' });
    const topic = h('span', { class: 'ui-orch__topic' });
    const meta = h('span', { class: 'ui-orch__meta' });
    const cost = h('span', { class: 'ui-orch__cost', hidden: true });
    const pill = h('span', { class: 'ui-orch__pill' });
    const reason = h('span', { class: 'ui-orch__reason', hidden: true });
    const go = () => {
      if (row._agentId) this.ctx.select({ type: 'agent', id: row._agentId }, { focus: true });
    };
    const row = h(
      'li',
      {
        class: 'ui-orch__front',
        on: {
          click: go,
          keydown: (ev: Event) => {
            const k = (ev as KeyboardEvent).key;
            if (k !== 'Enter' && k !== ' ') return;
            ev.preventDefault();
            go();
          },
        },
      },
      num,
      h('span', { class: 'ui-orch__body' }, topic, meta, cost, reason),
      pill,
    ) as unknown as FrontRow;
    row._num = num;
    row._topic = topic;
    row._meta = meta;
    row._cost = cost;
    row._pill = pill;
    row._reason = reason;
    return row;
  }

  private updateRow(row: FrontRow, f: OrchestrationFront): void {
    setText(row._num, String(f.n));
    setText(row._topic, f.topic);
    setTitle(row._topic, f.topic);
    const model = f.model ? modelName(f.model) : tr('Subagente');
    setText(row._meta, f.round > 1 ? tr('{0} · rodada {1}', [model, f.round]) : model);
    setText(row._pill, statusLabel(f.status));
    setVariant(row, 'is-', f.status);
    setHidden(row._reason, !f.reason);
    setText(row._reason, f.reason ?? '');
    const st = this.subStats.get(f.n);
    setHidden(row._cost, !st);
    setText(row._cost, st ? costText(st) : '');
    row._agentId = this.subs.get(f.n);
    const link = !!row._agentId;
    row.classList.toggle('is-link', link);
    setTitle(row, link ? tr('Abrir o subagente desta frente') : '');
    // Com subagente no escritório, a linha é um botão (teclado e leitor de tela); sem ele, só texto.
    setAttr(row, 'role', link ? 'button' : null);
    setAttr(row, 'tabindex', link ? '0' : null);
  }
}
