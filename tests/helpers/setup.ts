import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { installFakePorts, type FakePorts } from './fake-ports';

let ports: FakePorts | undefined;

beforeEach(() => {
  fakeBrowser.reset();
  // Not implemented by the fake; extension code reads it for language defaults.
  Object.assign(fakeBrowser.i18n, { getUILanguage: () => 'en-US' });
  ports = installFakePorts();
});

afterEach(() => {
  ports?.uninstall();
});
