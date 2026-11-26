type Terminal = typeof import('../../app/pages/bench/terminal.ts');

const denied = (): never => { throw new Error('Prompt session requested in isolated Git fixture'); };
export class Session { constructor() { denied(); } }

// Keep the production workbench and layout; only the Prompt process boundary is out of the test.
export const terminalFor: Terminal['terminalFor'] = () => document.createElement('div');
export const sessionFor: Terminal['sessionFor'] = denied;
export const agentSessionFor: Terminal['agentSessionFor'] = denied;
