/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */
// Decorators require 'any' for TypeScript type inference to work correctly.
// The decorator pattern wraps arbitrary methods/getters with unknown signatures.

"use strict";

import { done } from "./util";

// Type definitions for method signatures
type AnyMethod = (...args: any[]) => any;
type AsyncMethod = (...args: any[]) => Promise<any>;

/**
 * Generic decorator factory that wraps method or getter descriptors
 * @param decorator Function that wraps the original method/getter
 * @returns TypeScript decorator function
 *
 * Note: TypeScript's decorator type system requires flexible typing here.
 * The decorator wraps functions (methods or getters), but getters can return
 * non-function values (Uri, string, etc.), which TypeScript's strict checking
 * doesn't naturally accommodate. We use careful type assertions to preserve
 * as much type safety as possible while maintaining backward compatibility.
 */
function decorate<T extends AnyMethod>(
  decorator: (fn: T, key: string) => any
): (_target: any, key: string, descriptor: any) => void {
  return (_target: any, key: string, descriptor: any) => {
    let fnKey: "value" | "get" | null = null;
    let fn: T | null = null;

    if (typeof descriptor.value === "function") {
      fnKey = "value";
      fn = descriptor.value as T;
    } else if (typeof descriptor.get === "function") {
      fnKey = "get";
      fn = descriptor.get as T;
    }

    if (!fn || !fnKey) {
      throw new Error("not supported");
    }

    descriptor[fnKey] = decorator(fn, key);
  };
}

/**
 * Memoize decorator implementation - caches first call result
 * Preserves method return type using generics
 */
function _memoize<T extends AnyMethod>(
  fn: T,
  key: string
): (...args: Parameters<T>) => ReturnType<T> {
  const memoizeKey = `$memoize$${key}`;

  return function (this: any, ...args: Parameters<T>): ReturnType<T> {
    if (!Object.hasOwn(this, memoizeKey)) {
      Object.defineProperty(this, memoizeKey, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: fn.apply(this, args)
      });
    }

    return this[memoizeKey];
  } as T;
}

export const memoize = decorate(_memoize);

/**
 * Throttle decorator implementation - queues async operations
 * Constrains to async methods, preserves Promise return type
 */
function _throttle<T extends AsyncMethod>(
  fn: T,
  key: string
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const currentKey = `$throttle$current$${key}`;
  const nextKey = `$throttle$next$${key}`;

  const trigger = function (
    this: any,
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> {
    if (this[nextKey]) {
      return this[nextKey];
    }

    if (this[currentKey]) {
      this[nextKey] = done(this[currentKey]).then(() => {
        this[nextKey] = undefined;
        return trigger.apply(this, args);
      });

      return this[nextKey];
    }

    this[currentKey] = fn.apply(this, args);

    const clear = () => (this[currentKey] = undefined);
    done(this[currentKey]).then(clear, clear);

    return this[currentKey];
  };

  return trigger as T;
}

export const throttle = decorate(_throttle);

/**
 * Throttle variant whose single queued invocation keeps the latest arguments.
 * Useful for UI renders where intermediate targets are obsolete.
 */
function _throttleLatest<T extends AsyncMethod>(
  fn: T,
  key: string
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const currentKey = `$throttleLatest$current$${key}`;
  const nextKey = `$throttleLatest$next$${key}`;
  const nextArgsKey = `$throttleLatest$args$${key}`;

  const trigger = function (
    this: any,
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> {
    if (this[currentKey]) {
      this[nextArgsKey] = args;
      if (!this[nextKey]) {
        const runQueued = () => {
          const latestArgs = this[nextArgsKey] as Parameters<T>;
          this[nextArgsKey] = undefined;
          this[nextKey] = undefined;
          return trigger.apply(this, latestArgs);
        };
        this[nextKey] = done(this[currentKey]).then(runQueued, runQueued);
      }
      return this[nextKey];
    }

    this[currentKey] = fn.apply(this, args);
    const clear = () => (this[currentKey] = undefined);
    done(this[currentKey]).then(clear, clear);
    return this[currentKey];
  };

  return trigger as T;
}

export const throttleLatest = decorate(_throttleLatest);

/**
 * Sequentialize decorator implementation - serializes async operations
 * Constrains to async methods, preserves Promise return type
 */
function _sequentialize<T extends AsyncMethod>(
  fn: T,
  key: string
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const currentKey = `__$sequence$${key}`;

  return function (
    this: any,
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> {
    const currentPromise =
      (this[currentKey] as Promise<any>) ?? Promise.resolve(null);
    const run = async () => fn.apply(this, args);
    this[currentKey] = currentPromise.then(run, run);
    return this[currentKey];
  } as T;
}

export const sequentialize = decorate(_sequentialize);

/**
 * Debounce decorator - delays method execution
 * @param delay Milliseconds to delay
 */
export function debounce(
  delay: number
): (_target: any, key: string, descriptor: any) => void {
  return decorate((fn, key) => {
    const timerKey = `$debounce$${key}`;

    return function (this: any, ...args: any[]): void {
      clearTimeout(this[timerKey]);
      this[timerKey] = setTimeout(() => {
        this[timerKey] = undefined;
        fn.apply(this, args);
      }, delay);
    } as any;
  });
}

/** Cancel one pending invocation created by {@link debounce}. */
export function cancelDebounce(target: any, key: string): void {
  const timerKey = `$debounce$${key}`;
  clearTimeout(target[timerKey]);
  target[timerKey] = undefined;
}

const _seqList: Record<string, Promise<unknown>> = {};

/**
 * Global sequentialize decorator - serializes async operations across instances
 * Constrains to async methods, uses per-repo keys to prevent race conditions
 * @param name Unique key for the operation queue
 */
export function globalSequentialize(
  name: string
): (_target: any, key: string, descriptor: any) => void {
  return decorate((fn, _key) => {
    return function (this: any, ...args: any[]): Promise<any> {
      // Phase 20.B fix: Use per-repo keys to prevent multi-repo race conditions
      // Append repo root if available, ensuring each repo has independent queue
      const repoKey = this.root ? `${name}:${this.root}` : name;
      const currentPromise =
        (_seqList[repoKey] as Promise<any>) ?? Promise.resolve(null);
      // async is load-bearing: it converts sync throws from fn into
      // rejections so the sequentialize chain (.then(run, run)) survives
      // eslint-disable-next-line @typescript-eslint/require-await
      const run = async () => fn.apply(this, args);
      const resultPromise = currentPromise.then(run, run);
      _seqList[repoKey] = resultPromise;

      // Clean up key after promise settles to prevent memory leak
      void resultPromise.finally(() => {
        // Only delete if this is still the current promise for this key
        if (_seqList[repoKey] === resultPromise) {
          delete _seqList[repoKey];
        }
      });

      return resultPromise;
    } as any;
  });
}
