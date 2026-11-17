import { describe, expect, it } from 'vitest';
import {
  buildOrchestration,
  MAX_ORCH_EVENTS,
  orchestrationCounts,
  orchestrationRound,
  parseFrontLabel,
  parseOrchestrationCommand,
  parseOrchestrationText,
  pushOrchEvents,
  type OrchEvent,
} from './orchestration';

describe('parseFrontLabel', () => {
  it('lê número e tema com dois-pontos, travessão ou hífen', () => {
    expect(parseFrontLabel('Frente 3: ADRs dos repos')).toEqual({ n: 3, topic: 'ADRs dos repos' });
    expect(parseFrontLabel('frente 12 — Quadros GitHub')).toEqual({ n: 12, topic: 'Quadros GitHub' });
    expect(parseFrontLabel('Front 1 - links')).toEqual({ n: 1, topic: 'links' });
  });
  it('ignora descrições comuns', () => {
    expect(parseFrontLabel('Revisar código')).toBeUndefined();
    expect(parseFrontLabel('Frente 0: nada')).toBeUndefined();
    expect(parseFrontLabel(undefined)).toBeUndefined();
  });
});

describe('parseOrchestrationText', () => {
  it('acha início, vereditos e fim no meio do texto', () => {
    const text = [
      'Vou dividir o trabalho.',
      '[orquestração] Revisar a central',
      '',
      '- **[avaliação] Frente 1: aprovado — links conferidos**',
      '[avaliação] Frente 3: refazer — faltou citar a fonte',
      '[avaliacao] frente 2: Aprovada',
      '[orquestração] concluída — 5 frentes aprovadas',
    ].join('\n');
    expect(parseOrchestrationText(text, 10)).toEqual([
      { t: 'start', at: 10, title: 'Revisar a central' },
      { t: 'verdict', at: 10, n: 1, ok: true, reason: 'links conferidos' },
      { t: 'verdict', at: 10, n: 3, ok: false, reason: 'faltou citar a fonte' },
      { t: 'verdict', at: 10, n: 2, ok: true },
      { t: 'end', at: 10, summary: '5 frentes aprovadas' },
    ]);
  });
  it('tolera o que um modelo põe em volta (revisão da orquestração, frentes 1 e 5)', () => {
    const ev = (t: string) => parseOrchestrationText(t, 1);
    expect(ev('[orquestração] concluída.')).toEqual([{ t: 'end', at: 1 }]);
    expect(ev('[orquestração] concluída com ressalvas — frente 3 assumida')).toEqual([{ t: 'end', at: 1, summary: 'com ressalvas — frente 3 assumida' }]);
    expect(ev('**[avaliação]** Frente 3: aprovado')).toEqual([{ t: 'verdict', at: 1, n: 3, ok: true }]);
    expect(ev('[avaliação] Frente 2: aprovado com ressalva — faltou teste')).toEqual([{ t: 'verdict', at: 1, n: 2, ok: true, reason: 'com ressalva — faltou teste' }]);
    expect(ev('[avaliação] Frente 3: aprovado.')).toEqual([{ t: 'verdict', at: 1, n: 3, ok: true }]);
    expect(ev('**[avaliação] Frente 3: refazer** — **faltou a fonte**')).toEqual([{ t: 'verdict', at: 1, n: 3, ok: false, reason: 'faltou a fonte' }]);
    expect(ev('1. [avaliação] Frente 1: aprovado — x')).toEqual([{ t: 'verdict', at: 1, n: 1, ok: true, reason: 'x' }]);
    expect(ev('### [orquestração] Título')).toEqual([{ t: 'start', at: 1, title: 'Título' }]);
    expect(ev('| [avaliação] Frente 4: refazer — y |')).toEqual([{ t: 'verdict', at: 1, n: 4, ok: false, reason: 'y' }]);
    expect(ev('✅ [avaliação] Frente 5: aprovado')).toEqual([{ t: 'verdict', at: 1, n: 5, ok: true }]);
    // Texto antes do colchete com letras não é marca.
    expect(ev('Veja [avaliação] Frente 1: aprovado')).toEqual([]);
  });

  it('marcas em comandos de shell (echo), o canal que o transcript sempre guarda literalmente', () => {
    expect(parseOrchestrationCommand('echo "[avaliação] Frente 2: aprovado — ok"', 1)).toEqual([{ t: 'verdict', at: 1, n: 2, ok: true, reason: 'ok' }]);
    expect(parseOrchestrationCommand("echo '[orquestração] Revisar' && echo '[avaliação] Frente 1: refazer — falta'", 1)).toEqual([
      { t: 'start', at: 1, title: 'Revisar' },
      { t: 'verdict', at: 1, n: 1, ok: false, reason: 'falta' },
    ]);
    expect(parseOrchestrationCommand('Write-Output "[orquestração] concluída — 5 aprovadas"', 1)).toEqual([{ t: 'end', at: 1, summary: '5 aprovadas' }]);
    expect(parseOrchestrationCommand('grep -n "[avaliação] Frente 1: aprovado" arquivo.txt', 1)).toEqual([]);
    expect(parseOrchestrationCommand(undefined, 1)).toEqual([]);
  });

  it('texto sem protocolo não gera eventos', () => {
    expect(parseOrchestrationText('A frente 3 foi aprovada, sem colchetes.', 1)).toEqual([]);
  });
  it('mascara segredos no motivo', () => {
    const [e] = parseOrchestrationText('[avaliação] Frente 1: refazer — vazou sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 1);
    expect(e.t === 'verdict' && e.reason).not.toContain('abcdefghijklmnop');
  });
});

describe('buildOrchestration', () => {
  const spawn = (at: number, toolUseId: string, n: number, topic = `tema ${n}`): OrchEvent => ({ t: 'spawn', at, toolUseId, n, topic, model: 'sonnet' });

  it('mostra o modelo real do subagente quando ele é conhecido, senão o apelido da chamada', () => {
    const events: OrchEvent[] = [spawn(1, 'a', 1), spawn(1, 'b', 2), { t: 'spawn', at: 1, toolUseId: 'c', n: 3, topic: 'sem modelo' }];
    const real = new Map([
      ['a', 'claude-sonnet-5-5'],
      ['c', 'claude-opus-5-5'],
    ]);
    const o = buildOrchestration(events, (id) => real.get(id))!;
    expect(o.fronts.map((f) => f.model)).toEqual(['claude-sonnet-5-5', 'sonnet', 'claude-opus-5-5']);
  });

  it('acompanha frentes, entregas, vereditos e a nova rodada', () => {
    const events: OrchEvent[] = [
      { t: 'start', at: 1, title: 'Revisar a central' },
      spawn(2, 'a', 1),
      spawn(2, 'b', 2),
      spawn(2, 'c', 3),
      { t: 'delivered', at: 5, toolUseId: 'a', error: false },
      { t: 'delivered', at: 6, toolUseId: 'c', error: false },
      { t: 'delivered', at: 6, toolUseId: 'b', error: true },
      { t: 'verdict', at: 7, n: 1, ok: true, reason: 'ok' },
      { t: 'verdict', at: 7, n: 3, ok: false, reason: 'faltou a fonte' },
      spawn(8, 'd', 3),
    ];
    const o = buildOrchestration(events)!;
    expect(o.title).toBe('Revisar a central');
    expect(o.startedAt).toBe(1);
    expect(o.fronts.map((f) => [f.n, f.status, f.round])).toEqual([
      [1, 'approved', 1],
      [2, 'failed', 1],
      [3, 'working', 2],
    ]);
    expect(o.fronts[0]).toMatchObject({ model: 'sonnet', reason: 'ok' });
    expect(orchestrationRound(o)).toBe(2);
    expect(orchestrationCounts(o)).toEqual({ working: 1, delivered: 0, approved: 1, redo: 0, failed: 1 });
    expect(o.log.at(-1)).toEqual({ at: 8, kind: 'spawn', n: 3, round: 2, text: 'tema 3' });
  });

  it('a entrega da rodada anterior não mexe na rodada nova', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), { t: 'verdict', at: 2, n: 1, ok: false }, spawn(3, 'b', 1), { t: 'delivered', at: 4, toolUseId: 'a', error: false }])!;
    expect(o.fronts[0]).toMatchObject({ status: 'working', round: 2 });
  });

  it('sem início explícito, a primeira frente abre a orquestração; depois do fim, uma nova começa', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), { t: 'end', at: 2, summary: 'feito' }, spawn(5, 'b', 1, 'outra')])!;
    expect(o.startedAt).toBe(5);
    expect(o.endedAt).toBeUndefined();
    expect(o.fronts).toEqual([expect.objectContaining({ n: 1, topic: 'outra', round: 1 })]);
  });

  it('um início repetido no meio não zera as frentes; só dá nome se faltava (revisão, frente 2)', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), spawn(1, 'b', 2), { t: 'start', at: 2, title: 'Nome' }, { t: 'start', at: 3, title: 'Outro' }])!;
    expect(o.fronts).toHaveLength(2);
    expect(o.title).toBe('Nome');
  });

  it('a mesma chamada lida duas vezes não vira rodada 2', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), spawn(1, 'a', 1)])!;
    expect(o.fronts[0].round).toBe(1);
  });

  it('um início novo ainda sem frentes não esconde a orquestração anterior', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), { t: 'end', at: 2 }, { t: 'start', at: 3, title: 'Próxima' }])!;
    expect(o).toMatchObject({ endedAt: 2 });
    expect(o.fronts).toHaveLength(1);
  });

  it('marca o fim e guarda o resumo', () => {
    const o = buildOrchestration([spawn(1, 'a', 1), { t: 'end', at: 2, summary: 'feito' }])!;
    expect(o).toMatchObject({ endedAt: 2, summary: 'feito' });
  });

  it('sem frentes não há orquestração', () => {
    expect(buildOrchestration([{ t: 'start', at: 1, title: 'x' }])).toBeUndefined();
    expect(buildOrchestration([])).toBeUndefined();
  });

  it('pushOrchEvents guarda só os mais recentes', () => {
    let list: OrchEvent[] = [];
    for (let i = 0; i < MAX_ORCH_EVENTS + 5; i++) list = pushOrchEvents(list, [{ t: 'start', at: i }]);
    expect(list).toHaveLength(MAX_ORCH_EVENTS);
    expect(list[0].at).toBe(5);
  });
});
