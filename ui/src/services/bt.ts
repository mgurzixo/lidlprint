/**
 * bt.ts — Bluetooth Classic SPP bridge front-end.
 *
 * Talks to the Capacitor BluetoothClassicPlugin (Kotlin). The plugin moves
 * bytes; all protocol knowledge lives in printer-protocol.ts.
 *
 * Connection policy (SPEC §4.4): stateless per job — connect on demand,
 * disconnect after print or via explicit user tap.
 */
import { reactive } from 'vue';

export type BtState = 'disconnected' | 'connecting' | 'connected';

export interface BondedDevice {
  name: string;
  address: string;
}

interface BtPlugin {
  listBonded(): Promise<{ devices: BondedDevice[] }>;
  connect(options: { address: string }): Promise<void>;
  disconnect(): Promise<void>;
  write(options: { data: string /* base64 */ }): Promise<void>;
  read(options: { timeoutMs: number }): Promise<{ data: string /* base64, may be empty */ }>;
  isConnected(): Promise<{ connected: boolean }>;
}

declare global {
  interface Window {
    BluetoothClassic?: BtPlugin;
    // web/dev stub injections for manual testing
    LidlPrintShare?: { uri?: string; text?: string };
  }
}

function plugin(): BtPlugin {
  if (!window.BluetoothClassic) {
    throw new Error('BluetoothClassic plugin not available (web/dev build?)');
  }
  return window.BluetoothClassic;
}

// ---- base64 helpers (bridge carries base64 to avoid UTF-8 corruption) ----

export function b64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const STORAGE_KEY = 'lidlprint.printer';

function loadSavedPrinter(): BondedDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BondedDevice) : null;
  } catch {
    return null;
  }
}

export const bt = reactive({
  state: 'disconnected' as BtState,
  message: 'Ready.',
  isError: false,
  device: loadSavedPrinter() as BondedDevice | null,
});

function say(message: string, isError = false) {
  bt.message = message;
  bt.isError = isError;
}

export function useBt() {
  return {
    state: bt.state,
    message: bt.message,
    isError: bt.isError,
    device: bt.device,
    async listBonded(): Promise<BondedDevice[]> {
      return (await plugin().listBonded()).devices;
    },
    selectPrinter(d: BondedDevice) {
      bt.device = d;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
      say(`Selected ${d.name}. Tap Connect.`);
    },
    async connect(): Promise<boolean> {
      if (!bt.device) {
        say('No printer selected. Pick one in Settings.', true);
        return false;
      }
      bt.state = 'connecting';
      say(`Connecting to ${bt.device.name}…`);
      try {
        await plugin().connect({ address: bt.device.address });
        bt.state = 'connected';
        say(`Connected · ${bt.device.name}`);
        return true;
      } catch (e) {
        bt.state = 'disconnected';
        say(`Connect failed: ${String(e)}`, true);
        return false;
      }
    },
    async disconnect(message = 'Disconnected'): Promise<void> {
      try {
        await plugin().disconnect();
      } finally {
        bt.state = 'disconnected';
        say(message);
      }
    },
    /** ensure connected; used before a print */
    async ensureConnected(): Promise<boolean> {
      if (bt.state === 'connected') return true;
      return this.connect();
    },
    say,
  };
}

export { plugin as btPlugin };
