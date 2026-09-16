import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prompt, Run } from '../shared/types.ts';
import { Store } from './store.ts';

export const visualPrompt = '创建一个 HTML，内容是SVG绘制一个鹈鹕骑自行车的 2D 动画 禁止测试';
export const reasoningPrompt = `不要使用任何工具或写代码，直接推理回答以下问题:\x20
在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状(圆形和五角星形，不同的形状靠手感可以分辨）。数量如下:\x20
圆形:苹果味7颗，桃子味9颗，西瓜味8颗
五角星形:苹果味7颗，桃子味6颗，西瓜味4颗
问：最少取出多少颗糖,才能保证手中同时拥有“不同形状的苹果味
和桃子味的糖"？(即"圆形苹果味+五角星桃子味”或"圆形桃子味+五角星苹果味"，满足其一即可
请只给出你的最终答案数字，并简述推理过程。`;

export function defaultPrompts(now = new Date().toISOString()): Prompt[] {
  return [
    { id: 'prompt-pelican', title: '鹈鹕骑自行车', description: '用 SVG 和 HTML 展示角色、结构与动画能力。', category: 'visual', content: visualPrompt, referenceAnswer: '', rubric: '观察要点：鹈鹕辨识度、自行车结构、骑行动作与车轮同步、动画流畅度、画面完成度。完整保留原始输出，便于比较不同接口的表现。', tags: ['SVG', '动画', '创意编程'], enabled: true, createdAt: now, updatedAt: now },
    { id: 'prompt-candy', title: '黑袋里的糖果', description: '考察最坏情况推理，以及对可按形状选取这一条件的理解。', category: 'reasoning', content: reasoningPrompt, referenceAnswer: '21。利用手感取 12 颗五角星形和 9 颗圆形可以保证满足条件，20 颗不能保证。若禁止按形状选取、完全随机取出，则为 29。对照时请留意答案采用的取法。', rubric: '观察要点：是否说明取法；能否证明该数量必然成功（上界）；能否证明更少不能保证（下界）。保留关于题意歧义的讨论，结合完整推理过程对照。', tags: ['逻辑推理', '最坏情况', '数学'], enabled: true, createdAt: now, updatedAt: now },
  ];
}

export function seedData(store: Store) {
  if (store.all<Prompt>('prompts').length || store.all<Run>('runs').length) return;
  const now = new Date().toISOString();
  const prompts = defaultPrompts(now);
  store.transaction(() => {
    for (const prompt of prompts) store.put('prompts', prompt);
    for (const [index, file] of ['pelican.html', 'reasoning.txt'].entries()) {
      const path = resolve(process.cwd(), 'samples', file);
      if (!existsSync(path)) continue;
      const output = readFileSync(path, 'utf8'); const prompt = prompts[index];
      const run: Run = {
        id: `sample-${index === 0 ? 'pelican' : 'candy'}`, batchId: 'sample-session', promptId: prompt.id, modelId: '',
        providerName: '', modelName: '会话子代理', modelSlug: '', promptTitle: prompt.title, promptContent: prompt.content,
        category: prompt.category, referenceAnswer: prompt.referenceAnswer, rubric: prompt.rubric,
        status: 'completed', source: 'sample', sourceLabel: '会话子代理生成（未调用配置 API）', output,
        html: index === 0 ? output : '', reasoning: '', error: '', latencyMs: null, inputTokens: null, outputTokens: null,
        createdAt: now, finishedAt: now, parameters: {},
      };
      store.put('runs', run);
    }
  });
}
