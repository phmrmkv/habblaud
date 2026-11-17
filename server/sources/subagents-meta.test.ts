import { describe, expect, it } from 'vitest';
import { parseSubagentMeta } from './subagents';

describe('parseSubagentMeta', () => {
  it('lê o modelo que o app escolheu (pickedEffortModel), não só o apelido da chamada', () => {
    const meta = parseSubagentMeta(
      JSON.stringify({ agentType: 'general-purpose', description: 'Frente 1: planner', toolUseId: 'toolu_1', model: 'sonnet', pickedEffortModel: 'claude-sonnet-5-5' }),
    );
    expect(meta).toMatchObject({ description: 'Frente 1: planner', toolUseId: 'toolu_1', model: 'claude-sonnet-5-5' });
  });

  it('sem pickedEffortModel, fica sem modelo', () => {
    expect(parseSubagentMeta(JSON.stringify({ toolUseId: 'toolu_2', model: 'sonnet' }))?.model).toBeUndefined();
  });
});
