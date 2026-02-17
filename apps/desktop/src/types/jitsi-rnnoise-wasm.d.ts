declare module "@jitsi/rnnoise-wasm" {
  export function createRNNWasmModule(options?: unknown): Promise<any>;
  export function createRNNWasmModuleSync(options?: unknown): any;
}

