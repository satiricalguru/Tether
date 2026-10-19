import { useState } from 'react';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/** A number input that commits a clamped value on blur / Enter and reverts invalid text. */
export function NumberField({
  id,
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  hint?: string;
}) {
  // Text being edited; null shows the stored value (so outside changes appear).
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const commit = () => {
    setDraft(null);
    if (draft === null) return;
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === '') return;
    const clamped = Math.min(max, Math.max(min, step < 1 ? n : Math.round(n)));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span>
        <span className="block text-sm">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
