import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {errorText} from '../../app/errors.ts';
import {agentKey, forgetAgentKey, giveAgentKey, onAgentKey, type Shown} from '../../account/agent-key.ts';
import {isNative} from '../../app/host.ts';
import {button} from './parts.ts';

// Runtime's Agent: the one API key the box's Agent answers with, kept on this device alone. One line to give it in,
// whoever made the model it opens (its form says that); given, it is shown by its start and last four, the model it
// opens beside, with Remove. Nothing here names a maker: the person has a key, and the Agent answers.

/** The Agent's part: the key's line, or the key kept and Remove. `counted` hears whether there is one (the part's count). */
export function agentSection(counted: (n: number) => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section agent-part', 'aria-label': t('Agent')});
  const paint = (k: Shown | null) => {
    counted(k ? 1 : 0);
    section.replaceChildren(h('div', {class: 'agent-box'}, ...(k ? kept(k) : given())),
      h('p', {class: 'muted small agent-note'}, h('span', {}, keptWhere(k)),
        h('span', {}, t('Used by UI Agent and inherited by local Prompts.'))));
  };
  void agentKey().then(paint);
  // Heard while this page's part is there; once it is gone (the page made again), no longer.
  const stop = onAgentKey((k) => { if (!section.isConnected && section.childElementCount) stop(); else paint(k); });
  return section;
}

/**
 * Where the key is kept, as it is: in the app, the device's keyring (core device/vault.rs); in a browser, sealed by the
 * person's passkey (account/seal.ts), or, where it could not be, as given in the browser's own keeping.
 */
function keptWhere(k: Shown | null): string {
  if (isNative || !k) return t('Stored securely on this device only. Excluded from dotfiles and Remote sync.');
  return k.sealed ? t('Sealed by your passkey in this browser, opened once a session. Never sent to the Remote.')
    : t('Kept in this browser as given; with a passkey on your Remote it is sealed. Never sent to the Remote.');
}

/** The key kept: shown by its start and last four, the model it opens, and Remove. */
function kept(k: Shown): Node[] {
  const remove = button(t('Remove'));
  const error = h('span', {class: 'error small', role: 'alert'});
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try { await forgetAgentKey(); } catch (e) { remove.disabled = false; error.textContent = errorText(e); }
  });
  return [h('div', {class: 'agent-line'}, h('b', {}, t('API key')), h('span', {class: 'mono agent-shown'}, k.shown),
    h('span', {class: 'muted small agent-model'}, k.model), remove), error];
}

/** No key yet: the line to give one in, Use beside it; while it is tried, the maker is asked which model it opens. */
function given(): Node[] {
  const input = h('input', {class: 'line-in mono agent-in', type: 'password', autocomplete: 'off', spellcheck: 'false',
    'aria-label': t('API key'), placeholder: t('Paste API key')}) as HTMLInputElement;
  const use = button(t('Use'), 'primary');
  use.disabled = true;
  const said = h('p', {class: 'small agent-said', role: 'status'});
  input.addEventListener('input', () => { use.disabled = !input.value.trim(); said.textContent = ''; said.classList.remove('error'); });
  const go = async () => {
    if (use.disabled) return;
    use.disabled = input.disabled = true;
    said.classList.remove('error');
    said.textContent = t('Validating API key…');
    try { await giveAgentKey(input.value); }
    catch (e) {
      use.disabled = input.disabled = false;
      said.classList.add('error');
      // The maker not reached at all (offline, or it takes no asking from a page) is said so, not as the browser's words.
      said.textContent = e instanceof TypeError ? t('Cannot connect to Agent') : errorText(e);
      input.focus();
    }
  };
  use.addEventListener('click', () => void go());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void go(); } });
  return [h('label', {class: 'agent-line'}, h('b', {}, t('API key')), input, use), said];
}
