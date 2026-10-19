import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { installFakePorts, type FakePorts } from './fake-ports';

let ports: FakePorts | undefined;

beforeEach(() => {
  fakeBrowser.reset();
  ports = installFakePorts();
});

afterEach(() => {
  ports?.uninstall();
});
