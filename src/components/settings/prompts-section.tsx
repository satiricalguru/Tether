import { Download, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { downloadText } from '@/chat/export';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { usePrompts } from '@/hooks/use-prompts';
import {
  COMMAND_RE,
  exportPrompts,
  resetPrompts,
  savePrompts,
  validatePrompts,
  type PromptTemplate,
} from '@/prompts/library';

const VARS = ['{{page}}', '{{selection}}', '{{url}}', '{{title}}', '{{input}}'];

function Editor({
  initial,
  taken,
  onSave,
  onCancel,
}: {
  initial: PromptTemplate;
  taken: string[];
  onSave: (p: PromptTemplate) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const template = useRef<HTMLTextAreaElement>(null);
  const problem = !COMMAND_RE.test(draft.command)
    ? 'Commands use lowercase letters, digits and dashes.'
    : taken.includes(draft.command)
      ? `/${draft.command} is already used.`
      : !draft.name.trim()
        ? 'Give it a name.'
        : !draft.template.trim()
          ? 'Write a template.'
          : null;

  const insert = (v: string) => {
    const el = template.current;
    const at = el?.selectionStart ?? draft.template.length;
    const end = el?.selectionEnd ?? at;
    setDraft({ ...draft, template: draft.template.slice(0, at) + v + draft.template.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  };

  return (
    <form
      className="grid gap-2 rounded-md border border-border p-3"
      data-testid="prompt-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        onSave(draft).catch((err: unknown) => {
          setError((err as Error).message);
        });
      }}
    >
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        <div>
          <Label htmlFor="p-command">Command</Label>
          <div className="flex items-center gap-1">
            <span className="text-muted">/</span>
            <Input
              id="p-command"
              value={draft.command}
              onChange={(e) => {
                setDraft({ ...draft, command: e.target.value.toLowerCase().replace(/\s+/g, '-') });
              }}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="p-name">Name</Label>
          <Input
            id="p-name"
            value={draft.name}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
            }}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="p-template">Template</Label>
        <textarea
          id="p-template"
          ref={template}
          rows={4}
          value={draft.template}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs focus:ring-2 focus:ring-ring focus:outline-none"
          onChange={(e) => {
            setDraft({ ...draft, template: e.target.value });
          }}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
          Insert:
          {VARS.map((v) => (
            <button
              key={v}
              type="button"
              className="rounded border border-border px-1 font-mono hover:bg-surface-2"
              onClick={() => {
                insert(v);
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {'{{page}}'} and {'{{selection}}'} attach the page or selection, like the context chips.{' '}
          {'{{input}}'} is what you type after the command; {'{{input|English}}'} gives a default.
        </p>
      </div>
      <div>
        <Label htmlFor="p-description">Description (shown in the / menu)</Label>
        <Input
          id="p-description"
          value={draft.description ?? ''}
          onChange={(e) => {
            setDraft({ ...draft, description: e.target.value });
          }}
        />
      </div>
      {(problem ?? error) && (
        <p className="text-xs text-danger" role="alert">
          {error ?? problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!!problem}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PromptsSection() {
  const prompts = usePrompts();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const save = async (next: PromptTemplate[]) => {
    await savePrompts(next);
    setEditing(null);
  };

  const importFile = async (f: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await f.text()) as unknown;
    } catch {
      setNotice({ ok: false, text: `${f.name} isn’t valid JSON. Nothing was changed.` });
      return;
    }
    const v = validatePrompts(parsed);
    if (!v.ok) {
      setNotice({ ok: false, text: `${v.error} Nothing was changed.` });
      return;
    }
    // Imported prompts replace ones with the same command; the rest are kept.
    const incoming = new Set(v.prompts.map((p) => p.command));
    await savePrompts([...prompts.filter((p) => !incoming.has(p.command)), ...v.prompts]);
    setNotice({
      ok: true,
      text: `Imported ${v.prompts.length} prompt${v.prompts.length === 1 ? '' : 's'}.`,
    });
  };

  const blank: PromptTemplate = { id: 'new', command: '', name: '', template: '' };

  return (
    <Card>
      <CardTitle>Prompt library</CardTitle>
      <p className="mb-3 text-xs text-muted">
        Type <span className="font-mono">/</span> in the chat box to use these. Changes apply right
        away.
      </p>
      <ul className="mb-3 divide-y divide-border" data-testid="prompt-list">
        {prompts.map((p) =>
          editing === p.id ? (
            <li key={p.id} className="py-2">
              <Editor
                initial={p}
                taken={prompts.filter((x) => x.id !== p.id).map((x) => x.command)}
                onSave={(np) => save(prompts.map((x) => (x.id === p.id ? np : x)))}
                onCancel={() => {
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="flex items-center gap-2 py-2 text-sm" data-testid="prompt">
              <span className="w-24 shrink-0 font-mono text-xs">/{p.command}</span>
              <span className="min-w-0 flex-1 truncate">
                {p.name}
                <span className="block truncate text-xs text-muted">{p.template}</span>
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Edit /${p.command}`}
                onClick={() => {
                  setEditing(p.id);
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete /${p.command}`}
                onClick={() => void save(prompts.filter((x) => x.id !== p.id))}
              >
                <Trash2 />
              </Button>
            </li>
          ),
        )}
        {prompts.length === 0 && <li className="py-2 text-xs text-muted">No prompts.</li>}
      </ul>
      {editing === 'new' ? (
        <Editor
          initial={blank}
          taken={prompts.map((x) => x.command)}
          onSave={(np) => save([...prompts, { ...np, id: crypto.randomUUID() }])}
          onCancel={() => {
            setEditing(null);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing('new');
            }}
          >
            <Plus /> New prompt
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              downloadText('tether-prompts.json', exportPrompts(prompts), 'application/json');
            }}
          >
            <Download /> Export
          </Button>
          <Button size="sm" variant="outline" onClick={() => file.current?.click()}>
            <Upload /> Import
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import prompts file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => void resetPrompts()}>
            <RotateCcw /> Reset to defaults
          </Button>
        </div>
      )}
      {notice && (
        <p
          className={notice.ok ? 'mt-2 text-xs text-muted' : 'mt-2 text-xs text-danger'}
          role="status"
          data-testid="prompt-notice"
        >
          {notice.text}
        </p>
      )}
    </Card>
  );
}
