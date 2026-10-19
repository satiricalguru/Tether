import { ChevronDown, ChevronRight, Eraser, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { SetupDoctor } from '@/components/doctor/setup-doctor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  useProviderStatus,
  useRemoveProvider,
  useResetOverrides,
  useSaveProvider,
} from '@/hooks/use-providers';
import { isBuiltin } from '@/providers/defaults';
import type { ProviderStatus } from '@/providers/registry';
import { ModelList } from './model-list';
import { ProviderForm } from './provider-form';

function ProviderCard({
  p,
  editing,
  onEdit,
}: {
  p: ProviderStatus;
  editing: boolean;
  onEdit: (id: string | undefined) => void;
}) {
  const save = useSaveProvider();
  const remove = useRemoveProvider();
  const resetOverrides = useResetOverrides();
  const [open, setOpen] = useState(false);
  const healthy = p.health?.ok ?? false;

  return (
    <li className="rounded-lg border border-border p-3" data-testid={`provider-${p.instanceId}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-left disabled:opacity-60"
          onClick={() => {
            setOpen((v) => !v);
          }}
          disabled={!healthy}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} models for ${p.label}`}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <span className="truncate font-medium">{p.label}</span>
        </button>
        <span className="truncate font-mono text-xs text-muted">{p.baseUrl}</span>
        {p.useOpenAICompat && <Badge>/v1</Badge>}
        {p.hasApiKey && <Badge>key</Badge>}
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Edit ${p.label}`}
            onClick={() => onEdit(editing ? undefined : p.instanceId)}
          >
            <Pencil />
          </Button>
          {!isBuiltin(p.instanceId) && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${p.label}`}
              onClick={() => remove.mutate(p.instanceId)}
            >
              <Trash2 />
            </Button>
          )}
          <Switch
            checked={p.enabled}
            aria-label={`Enable ${p.label}`}
            onCheckedChange={(enabled) =>
              save.mutate({
                instanceId: p.instanceId,
                kind: p.kind,
                label: p.label,
                baseUrl: p.baseUrl,
                enabled,
                useOpenAICompat: p.useOpenAICompat,
              })
            }
          />
        </span>
      </div>
      {editing && (
        <div className="mt-3 border-t border-border pt-3">
          <ProviderForm existing={p} onDone={() => onEdit(undefined)} />
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <p className="text-[11px] text-muted">
              Tether remembers features this server rejected (native tools, usage stats) per model.
              Clear that after upgrading the server.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={resetOverrides.isPending}
              onClick={() => resetOverrides.mutate(p.instanceId)}
            >
              <Eraser /> {resetOverrides.isSuccess ? 'Forgotten' : 'Forget learned limits'}
            </Button>
          </div>
        </div>
      )}
      {open && healthy && (
        <div className="mt-2 border-t border-border pt-2">
          <ModelList instanceId={p.instanceId} kind={p.kind} />
        </div>
      )}
    </li>
  );
}

export function ProvidersSection() {
  const status = useProviderStatus();
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <SetupDoctor onEditKey={setEditing} />
      </Card>
      <Card>
        <div className="mb-2 flex items-center">
          <CardTitle className="mb-0">Model servers</CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus /> Add endpoint
          </Button>
        </div>
        {adding && (
          <div className="mb-3 rounded-lg border border-border p-3">
            <ProviderForm
              onDone={() => {
                setAdding(false);
              }}
            />
          </div>
        )}
        <ul className="space-y-2">
          {(status.data ?? []).map((p) => (
            <ProviderCard
              key={p.instanceId}
              p={p}
              editing={editing === p.instanceId}
              onEdit={setEditing}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
