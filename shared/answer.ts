export type AnswerVerdict = 'correct' | 'incorrect' | 'ungraded' | 'unavailable';
export interface ExtractedAnswer {
  verdict: AnswerVerdict;
  answer: string;
  error?: string;
}

function cleanOutput(text: string): string {
  const withoutThinking = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  if (/<think\b/i.test(withoutThinking)) return '';
  return withoutThinking.normalize('NFKC').replace(/```[^\n]*\n?/g, '').replace(/\*\*|__/g, '').replace(/`|\$/g, '');
}

function sameNumber(left: string, right: string): boolean {
  const leftNumber = Number(left), rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

/** Extract the first numeric token after removing common model formatting. */
export function extractNumericAnswer(output: string, expectedAnswer?: string): ExtractedAnswer {
  const text = cleanOutput(output);
  if (!text) return { verdict: 'unavailable', answer: '', error: '测试正文暂不可用。' };
  const match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return { verdict: expectedAnswer ? 'incorrect' : 'ungraded', answer: '' };
  const answer = match[0]!;
  const expected = expectedAnswer?.trim();
  if (!expected) return { verdict: 'ungraded', answer };
  return { verdict: sameNumber(answer, expected) ? 'correct' : 'incorrect', answer };
}
