// The desktop app's window onto its host: Tauri's API, which only the app has. The web's build takes
// tauri.web.ts in its place (vite.config.ts), so it carries none of it.

import type {EventCallback, UnlistenFn} from '@tauri-apps/api/event';

/** A command of the app's (src-tauri), by name. */
export const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args);

/** Hear an event the app emits; returns how to stop. */
export const listen = async <T>(event: string, fn: EventCallback<T>): Promise<UnlistenFn> =>
  (await import('@tauri-apps/api/event')).listen<T>(event, fn);

/** Name the app's window as the page is named. */
export const setWindowTitle = async (title: string): Promise<void> =>
  (await import('@tauri-apps/api/window')).getCurrentWindow().setTitle(title);
