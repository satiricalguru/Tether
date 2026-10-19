import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { echoStream } from '@/background/echo';
import { App } from '@/entrypoints/sidepanel/App';
import { registerHandlers } from '@/lib/messaging';
import { registerStreamHandlers } from '@/lib/ports';

afterEach(cleanup);

describe('side panel shell', () => {
  it('shows the background as connected', async () => {
    registerHandlers({ 'bg:ping': () => ({ pong: true, version: '0.1.0', at: 0 }) });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('bg-status').dataset.state).toBe('connected');
    });
    expect(screen.getByTestId('bg-status').textContent).toContain('v0.1.0');
  });

  it('shows an unreachable background', async () => {
    registerHandlers({});
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('bg-status').dataset.state).toBe('error');
    });
  });

  it('streams the transport check end to end', async () => {
    registerHandlers({ 'bg:ping': () => ({ pong: true, version: '0.1.0', at: 0 }) });
    registerStreamHandlers({ echo: echoStream });
    render(<App />);
    fireEvent.change(screen.getByLabelText('Transport check input'), {
      target: { value: 'local tokens only' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(
      () => {
        expect(screen.getByTestId('echo-state').textContent).toBe('done');
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId('echo-output').textContent).toBe('local tokens only');
  });
});
