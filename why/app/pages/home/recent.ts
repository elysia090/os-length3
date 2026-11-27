import type {Connection} from '../../../shipto/connection.ts';

/** The same account on the same Remote can keep its view across a session renewal. If the account is not known,
 * only the exact session is known to be the same one. Signed-out reads hold local and guest work alone. */
export function recentScope(connection: Connection | null): string | null {
  return connection ? JSON.stringify(connection.user ? [connection.url, 'account', connection.user]
    : [connection.url, 'session', connection.session]) : null;
}

/** Only the current account's last view and the latest read can be kept. A scope change drops both, even if the
 * device switches back to the same account before an earlier read answers. */
export class RecentSnapshot<T> {
  private scope: string | null = null;
  private snapshot: T | undefined;
  private revision = 0;

  read(scope: string | null) {
    if (this.scope !== scope) {
      this.scope = scope;
      this.snapshot = undefined;
      ++this.revision;
    }
    return this.snapshot;
  }

  begin(scope: string | null) {
    this.read(scope);
    return ++this.revision;
  }

  current(scope: string | null, read: number) {
    this.read(scope);
    return read === this.revision;
  }

  keep(scope: string | null, read: number, snapshot: T) {
    if (!this.current(scope, read)) return false;
    this.snapshot = snapshot;
    return true;
  }
}
