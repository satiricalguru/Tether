import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useSaveProvider } from '@/hooks/use-providers';
import { isBuiltin } from '@/providers/defaults';
import { isLocalUrl, normalizeBaseUrl } from '@/providers/http';
import type { ProviderStatus } from '@/providers/registry';
import type { ProviderKind } from '@/providers/types';

const KIND_LABEL: Record<ProviderKind, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp server',
  'openai-compatible': 'OpenAI-compatible (vLLM, LocalAI, Jan, KoboldCpp, …)',
};

export interface ProviderFormProps {
  /** Omit to add a new endpoint. */
  existing?: ProviderStatus;
  onDone: () => void;
}

/**
 * Add or edit an endpoint. For a host outside this computer, the browser's
 * permission prompt is shown first — it must run inside the click.
 */
export function ProviderForm({ existing, onDone }: ProviderFormProps) {
  const save = useSaveProvider();
  const [label, setLabel] = useState(existing?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? 'http://127.0.0.1:');
  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? 'openai-compatible');
  const [apiKey, setApiKey] = useState('');
  const [compat, setCompat] = useState(existing?.useOpenAICompat ?? false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setError(undefined);
    let url: string;
    try {
      url = normalizeBaseUrl(baseUrl);
    } catch {
      setError('Enter a valid URL, e.g. http://127.0.0.1:8000');
      return;
    }
    if (!isLocalUrl(url)) {
      const granted = await browser.permissions.request({ origins: [`${new URL(url).origin}/*`] });
      if (!granted) {
        setError(`Tether can't reach ${new URL(url).host} without your permission.`);
        return;
      }
    }
    save.mutate(
      {
        instanceId: existing?.instanceId ?? '',
        kind,
        label: label || new URL(url).host,
        baseUrl: url,
        enabled: existing?.enabled ?? true,
        useOpenAICompat: kind === 'ollama' && compat,
        ...(apiKey ? { apiKey } : {}),
      },
      {
        onSuccess: onDone,
        onError: (e) => {
          setError(e.message);
        },
      },
    );
  };

  const idPrefix = existing?.instanceId ?? 'new';
  return (
    <form
      className="grid gap-3"
      data-testid={`provider-form-${idPrefix}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-label`}>Name</Label>
          <Input
            id={`${idPrefix}-label`}
            value={label}
            placeholder="My vLLM box"
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-kind`}>Type</Label>
          <select
            id={`${idPrefix}-kind`}
            value={kind}
            disabled={!!existing && isBuiltin(existing.instanceId)}
            onChange={(e) => {
              setKind(e.target.value as ProviderKind);
            }}
            className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm"
          >
            {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-url`}>Base URL</Label>
        <Input
          id={`${idPrefix}-url`}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
          }}
          className="font-mono"
        />
      </div>
      {kind === 'openai-compatible' && (
        <div>
          <Label htmlFor={`${idPrefix}-key`}>API key (optional)</Label>
          <Input
            id={`${idPrefix}-key`}
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={
              existing?.hasApiKey
                ? '•••••••• (saved; type to replace)'
                : 'Only if the server requires one'
            }
            onChange={(e) => {
              setApiKey(e.target.value);
            }}
          />
          <p className="mt-1 text-[11px] text-muted">
            Stored only in this browser profile and never logged.
          </p>
        </div>
      )}
      {kind === 'ollama' && (
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={compat}
            onCheckedChange={setCompat}
            aria-label="Use OpenAI-compatible endpoint"
          />
          Use Ollama’s OpenAI-compatible endpoint (/v1) instead of the native API
        </label>
      )}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {existing ? 'Save' : 'Add endpoint'}
        </Button>
      </div>
    </form>
  );
}
