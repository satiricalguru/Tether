/**
 * Heuristic prompt-injection scanner for page-derived text. It can't prove a
 * page is safe; it flags text that is *addressed to an AI* so the user can
 * see it. The real defense is structural: page text is fenced as untrusted
 * data and hidden text is never included at all.
 */

export interface InjectionFinding {
  rule: string;
  excerpt: string;
}

const RULES: [string, RegExp][] = [
  [
    'ignore-instructions',
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  ],
  [
    'new-role',
    /\byou are (now|no longer)\b|\bfrom now on,? you\b|\bact as (an?|the) (unfiltered|jailbroken|different)\b|\bpretend (to be|you are)\b/i,
  ],
  [
    'fake-system',
    /(^|\n)\s*(system|assistant|developer)\s*:|<\/?\s*(system|assistant)\s*>|\[\/?(INST|SYS)\]|<<\/?SYS>>/i,
  ],
  // Raw chat-template control tokens (ChatML, Llama 3, Gemma) have no business in page text.
  [
    'template-tokens',
    /<\|(im_start|im_end|eot_id|start_header_id|end_header_id|system|user|assistant)\|>|<(start|end)_of_turn>/i,
  ],
  [
    'secrecy',
    /\b(do not|don't|never) (tell|inform|mention|reveal|alert)\b[^.\n]{0,30}\b(the )?user\b/i,
  ],
  [
    'addressed-to-ai',
    /\b(attention|note|message|instructions?) (to|for) (the )?(ai|assistant|llm|language model|chatbot|agent)\b|\bif you are an? (ai|llm|language model|assistant|agent)\b/i,
  ],
  [
    'exfiltration',
    /\b(send|post|upload|forward|exfiltrate|email)\b[^.\n]{0,40}\b(password|credentials?|cookies?|tokens?|api keys?|conversation|chat history|personal data)\b/i,
  ],
  [
    'tool-hijack',
    /\b(click|navigate|go to|open|visit|submit|purchase|buy|transfer)\b[^.\n]{0,30}\b(immediately|right now|without asking|without confirmation)\b/i,
  ],
];

export function scanForInjection(text: string, maxFindings = 5): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [rule, re] of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 30);
    const excerpt = text
      .slice(start, m.index + m[0].length + 30)
      .replace(/\s+/g, ' ')
      .trim();
    findings.push({ rule, excerpt });
    if (findings.length >= maxFindings) break;
  }
  return findings;
}
