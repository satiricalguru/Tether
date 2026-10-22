import { useEffect, useState } from 'react';
import { DEFAULT_PROMPTS, getPrompts, watchPrompts, type PromptTemplate } from '@/prompts/library';

/** The prompt library, live: loads once, then follows edits from the settings page. */
export function usePrompts(): PromptTemplate[] {
  const [prompts, setPrompts] = useState<PromptTemplate[]>(DEFAULT_PROMPTS);
  useEffect(() => {
    let alive = true;
    void getPrompts().then((p) => {
      if (alive) setPrompts(p);
    });
    const unwatch = watchPrompts(setPrompts);
    return () => {
      alive = false;
      unwatch();
    };
  }, []);
  return prompts;
}
