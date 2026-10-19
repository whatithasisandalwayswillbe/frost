// Loads Node's built-in node:ffi module for the native filesystem, console and audio bindings.
// The types cover only the parts frost uses.
import { createRequire } from 'node:module';

export type FFIType =
  | 'void'
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float'
  | 'double'
  | 'pointer'
  | 'string'
  | 'buffer';

export type FFIValue = number | bigint | string | Buffer | null;

interface FFISignature {
  return: FFIType;
  arguments: FFIType[];
}

export interface FFILibrary {
  close(): void;
  getFunction(name: string, signature: FFISignature): (...args: FFIValue[]) => number | bigint | undefined;
  getSymbol(name: string): bigint;
}

export interface FFI {
  dlopen(
    path: string | null,
    functions?: Record<string, FFISignature>,
  ): {
    lib: FFILibrary;
    functions: Record<string, (...args: FFIValue[]) => number | bigint | undefined>;
  };
  getRawPointer(value: Buffer): bigint;
  getInt32(pointer: bigint, offset?: number): number;
  setInt32(pointer: bigint, offset: number, value: number): void;
  getUint8(pointer: bigint, offset?: number): number;
  getUint16(pointer: bigint, offset?: number): number;
  // Copies length bytes from native memory.
  toBuffer(pointer: bigint, length: number): Buffer;
  // Reads a NUL-terminated UTF-8 string from native memory.
  toString(pointer: bigint): string;
}

let loaded: FFI | undefined;
const require = createRequire(import.meta.url);

// Loads node:ffi once. Only its exact experimental warning is muted, and only while it loads.
export function loadFFI(): FFI {
  if (loaded) return loaded;
  const original = process.emitWarning;
  process.emitWarning = function (...args: unknown[]): void {
    if (
      args[0] === 'FFI is an experimental feature and might change at any time' &&
      args[1] === 'ExperimentalWarning' &&
      args[2] === undefined
    )
      return;
    Reflect.apply(original, process, args);
  } as typeof process.emitWarning;
  try {
    loaded = require('node:ffi') as FFI;
    return loaded;
  } finally {
    process.emitWarning = original;
  }
}
