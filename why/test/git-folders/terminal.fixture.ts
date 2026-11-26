type Terminal = typeof import('../../app/pages/bench/terminal.ts');

// The workbench subscribes to a repo's terminal log, even without a visible pane.
// It may observe these empty logs; no runtime or process capability is provided.
export class Session {
  readonly element = document.createElement('div');
  readonly runs = [];
  watch() { return () => {}; }
}
const idle = new Map<string, Session>();
const blank = (repo: string) => {
  const session = idle.get(repo) ?? new Session();
  idle.set(repo, session);
  return session;
};
export const terminalFor: Terminal['terminalFor'] = repo => blank(repo).element;
export const sessionFor: Terminal['sessionFor'] = repo => blank(repo) as unknown as ReturnType<Terminal['sessionFor']>;
export const agentSessionFor: Terminal['agentSessionFor'] = () => { throw new Error('No guest in the Git fixture'); };
