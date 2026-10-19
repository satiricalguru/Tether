import { describe, expect, it } from 'vitest';
import { doctorReport, ollamaOriginFixes, startHints, type DoctorInput } from '@/providers/doctor';
import type { Diagnosis } from '@/providers/types';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function input(diagnosis: Diagnosis | 'ok', extra: Partial<DoctorInput> = {}): DoctorInput {
  return {
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    enabled: true,
    extensionOrigin: ORIGIN,
    health:
      diagnosis === 'ok'
        ? { ok: true, version: '0.12.6', latencyMs: 4, diagnosis: 'ok' }
        : { ok: false, latencyMs: 4, diagnosis },
    ...extra,
  };
}

describe('doctorReport', () => {
  it('reports connected with version and latency', () => {
    expect(doctorReport(input('ok'))).toMatchObject({
      severity: 'ok',
      title: 'Connected',
      summary: 'v0.12.6 · 4 ms',
    });
  });

  it('gives OS-specific OLLAMA_ORIGINS fixes scoped to this extension', () => {
    const r = doctorReport(input('origin-blocked'));
    expect(r.severity).toBe('error');
    expect(r.fixes.map((f) => f.label)).toEqual(['macOS', 'Linux', 'Windows', 'Terminal']);
    for (const f of r.fixes) expect(f.code).toContain(ORIGIN);
    expect(r.fixes[1]?.code).toContain('systemctl edit ollama.service');
    expect(r.fixes[2]?.code).toBe(`setx OLLAMA_ORIGINS "${ORIGIN}"`);
    expect(r.fixes[3]?.text).toContain('chrome-extension://*');
  });

  it('uses the right scheme for Firefox', () => {
    expect(ollamaOriginFixes('moz-extension://1234')[3]?.text).toContain('moz-extension://*');
  });

  it('tells non-Ollama servers how to allow the origin', () => {
    const r = doctorReport(input('origin-blocked', { kind: 'lmstudio', label: 'LM Studio' }));
    expect(r.summary).toContain(ORIGIN);
    expect(r.fixes).toEqual([]);
  });

  it('shows how to start each server when not running, using its port', () => {
    expect(doctorReport(input('unreachable')).fixes[0]?.code).toContain('ollama serve');
    expect(startHints('lmstudio', 'LM Studio', 'http://127.0.0.1:1300')[0]?.code).toBe(
      'lms server start --port 1300',
    );
    expect(startHints('llamacpp', 'llama.cpp', 'http://127.0.0.1:8080')[0]?.code).toContain(
      '--jinja',
    );
    expect(startHints('openai-compatible', 'vLLM', 'http://127.0.0.1:8000')[0]?.code).toContain(
      'vllm serve',
    );
    expect(startHints('openai-compatible', 'Jan', 'http://127.0.0.1:1337')[0]?.text).toContain(
      '1337',
    );
  });

  it('asks for permission or a key where that is the fix', () => {
    const perm = doctorReport(input('needs-permission', { baseUrl: 'http://gpu-box.lan:8000' }));
    expect(perm.action).toBe('grant-permission');
    expect(perm.summary).toContain('gpu-box.lan:8000');
    expect(doctorReport(input('auth-required')).action).toBe('edit-api-key');
  });

  it('marks disabled providers as unchecked', () => {
    expect(doctorReport(input('ok', { enabled: false })).title).toBe('Disabled');
    expect(doctorReport(input('ok', { health: null })).title).toBe('Disabled');
  });
});
