import type { Diagnosis, HealthResult, ProviderKind } from './types';

/**
 * Turns a provider's health into what the Setup Doctor shows: a short
 * verdict and copy-pasteable fixes. Pure, so every message is unit-tested.
 */

export type Severity = 'ok' | 'info' | 'warn' | 'error';

export interface FixStep {
  /** e.g. "macOS", "Linux (systemd)" — rendered as tabs when there are several. */
  label: string;
  text: string;
  code?: string;
}

export interface DoctorReport {
  severity: Severity;
  title: string;
  summary: string;
  fixes: FixStep[];
  /** UI affordance needed beyond copy-paste. */
  action?: 'grant-permission' | 'edit-api-key';
}

export interface DoctorInput {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
  health: HealthResult | null;
  /** `chrome-extension://<id>` (or `moz-extension://<uuid>`). */
  extensionOrigin: string;
}

function port(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '';
  }
}

export function ollamaOriginFixes(extensionOrigin: string): FixStep[] {
  const scheme = extensionOrigin.split('://')[0] ?? 'chrome-extension';
  const exact = extensionOrigin;
  const any = `${scheme}://*`;
  return [
    {
      label: 'macOS',
      text: 'Set the variable for apps launched from the Dock, then quit Ollama from the menu bar and open it again.',
      code: `launchctl setenv OLLAMA_ORIGINS "${exact}"`,
    },
    {
      label: 'Linux',
      text: 'Add an override to the systemd service, then reload and restart it.',
      code: `sudo systemctl edit ollama.service
# add these two lines in the editor:
[Service]
Environment="OLLAMA_ORIGINS=${exact}"

sudo systemctl daemon-reload && sudo systemctl restart ollama`,
    },
    {
      label: 'Windows',
      text: 'Set a user environment variable, then quit Ollama from the system tray and start it again.',
      code: `setx OLLAMA_ORIGINS "${exact}"`,
    },
    {
      label: 'Terminal',
      text: `Running "ollama serve" yourself? Prefix it. To allow every extension instead of only Tether, use ${any}.`,
      code: `OLLAMA_ORIGINS="${exact}" ollama serve`,
    },
  ];
}

export function startHints(kind: ProviderKind, label: string, baseUrl: string): FixStep[] {
  const p = port(baseUrl);
  switch (kind) {
    case 'ollama':
      return [
        {
          label: 'Start',
          text: 'Open the Ollama app, or start the server in a terminal. Then pull a model if you have none.',
          code: `ollama serve\nollama pull llama3.2`,
        },
      ];
    case 'lmstudio':
      return [
        {
          label: 'Start',
          text: 'In LM Studio open the Developer tab and switch "Status" to Running, or use the CLI.',
          code: `lms server start --port ${p || '1234'}`,
        },
      ];
    case 'llamacpp':
      return [
        {
          label: 'Start',
          text: '--jinja enables native tool calling with the model’s own chat template.',
          code: `llama-server -m ./model.gguf --port ${p || '8080'} --jinja`,
        },
      ];
    case 'openai-compatible':
      if (/vllm/i.test(label)) {
        return [
          {
            label: 'Start',
            text: 'The tool-call flags let vLLM return native tool calls.',
            code: `vllm serve Qwen/Qwen2.5-7B-Instruct --port ${p || '8000'} --enable-auto-tool-choice --tool-call-parser hermes`,
          },
        ];
      }
      return [
        {
          label: 'Start',
          text: `Start ${label} with its OpenAI-compatible API enabled on port ${p}, or correct the URL.`,
        },
      ];
  }
}

const SUMMARY: Record<Exclude<Diagnosis, 'ok'>, (i: DoctorInput) => Omit<DoctorReport, 'fixes'>> = {
  unreachable: (i) => ({
    severity: 'info',
    title: 'Not running',
    summary: `Nothing is answering at ${i.baseUrl}.`,
  }),
  timeout: (i) => ({
    severity: 'warn',
    title: 'Not responding',
    summary: `${i.baseUrl} accepted the connection but didn’t answer in time. The server may be busy loading a model, or a firewall is holding the connection.`,
  }),
  'origin-blocked': (i) => ({
    severity: 'error',
    title: 'Blocked by origin check',
    summary:
      i.kind === 'ollama'
        ? 'Ollama is running but rejects requests from browser extensions until you allow Tether’s origin with OLLAMA_ORIGINS.'
        : `${i.label} is running but rejected the extension’s Origin header (HTTP 403). Allow ${i.extensionOrigin} in its CORS settings.`,
  }),
  'needs-permission': (i) => ({
    severity: 'warn',
    title: 'Needs permission',
    summary: `${new URL(i.baseUrl).host} isn’t on this computer, so Tether needs your permission to contact it.`,
    action: 'grant-permission',
  }),
  'auth-required': () => ({
    severity: 'error',
    title: 'API key required',
    summary: 'The server answered 401 Unauthorized. Add the API key it was started with.',
    action: 'edit-api-key',
  }),
  'http-error': (i) => ({
    severity: 'warn',
    title: 'Server error',
    summary: i.health?.detail ?? 'The server answered with an error.',
  }),
  'bad-response': (i) => ({
    severity: 'warn',
    title: 'Unexpected server',
    summary: `Something is listening on port ${port(i.baseUrl)}, but it doesn’t look like ${i.label}. Check the URL or choose a different backend type.`,
  }),
};

export function doctorReport(input: DoctorInput): DoctorReport {
  if (!input.enabled || !input.health) {
    return { severity: 'info', title: 'Disabled', summary: 'Not checked.', fixes: [] };
  }
  const h = input.health;
  if (h.ok) {
    return {
      severity: 'ok',
      title: 'Connected',
      summary: `${h.version ? `v${h.version} · ` : ''}${h.latencyMs} ms`,
      fixes: [],
    };
  }
  const base = SUMMARY[h.diagnosis === 'ok' ? 'http-error' : h.diagnosis](input);
  let fixes: FixStep[] = [];
  if (h.diagnosis === 'origin-blocked' && input.kind === 'ollama') {
    fixes = ollamaOriginFixes(input.extensionOrigin);
  } else if (h.diagnosis === 'unreachable' || h.diagnosis === 'timeout') {
    fixes = startHints(input.kind, input.label, input.baseUrl);
  }
  return { ...base, fixes };
}
