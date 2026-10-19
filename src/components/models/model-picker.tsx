import { useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemText,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAllModels } from '@/hooks/use-providers';
import { useSettings } from '@/hooks/use-settings';
import { parseSelectionKey, selectionKey } from '@/lib/format';
import type { ModelGroup } from '@/providers/registry';
import { modelDetail } from './model-badges';

/** Chat-capable models only; embedding models can't answer. */
export function chatGroups(groups: ModelGroup[]): ModelGroup[] {
  return groups
    .map((g) => ({ ...g, models: g.models.filter((m) => m.kind !== 'embeddings') }))
    .filter((g) => g.models.length > 0);
}

/** The first hot model anywhere, else the first model. */
export function defaultSelection(
  groups: ModelGroup[],
): { instanceId: string; model: string } | null {
  const all = groups.flatMap((g) => g.models.map((m) => ({ g, m })));
  const pick = all.find((x) => x.m.loaded) ?? all[0];
  return pick ? { instanceId: pick.g.instanceId, model: pick.m.id } : null;
}

export function ModelPicker({ className }: { className?: string }) {
  const { data, isPending } = useAllModels();
  const { settings, update } = useSettings();
  const groups = chatGroups(data ?? []);
  const sel = settings?.selection;
  const current =
    sel &&
    groups.some((g) => g.instanceId === sel.instanceId && g.models.some((m) => m.id === sel.model))
      ? selectionKey(sel.instanceId, sel.model)
      : undefined;

  // Keep a valid selection: choose a sensible default when none / gone.
  useEffect(() => {
    if (!settings || isPending || current) return;
    const next = defaultSelection(groups);
    if (next) void update({ selection: next });
  }, [settings, isPending, current, groups, update]);

  return (
    <Select
      {...(current ? { value: current } : {})}
      onValueChange={(v) => {
        const parsed = parseSelectionKey(v);
        if (parsed) void update({ selection: parsed });
      }}
      disabled={groups.length === 0}
    >
      <SelectTrigger aria-label="Model" className={className} data-testid="model-picker">
        <SelectValue placeholder={isPending ? 'Loading models…' : 'No models available'} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectGroup key={g.instanceId}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.models.map((m) => (
              <SelectItem key={m.id} value={selectionKey(g.instanceId, m.id)}>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 truncate">
                    {m.loaded && (
                      <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-label="loaded" />
                    )}
                    <SelectItemText>{m.name}</SelectItemText>
                  </span>
                  <span className="truncate text-[11px] text-muted">{modelDetail(m)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
