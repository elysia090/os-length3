// The Japanese for every English text, gathered from each part of the OS.
// A part's file maps its English texts to Japanese; src/i18n.test.ts checks
// that every t('…') in the source has one.
//
//   shell    the rail and the person's menu      base     shared words and models
//   pages    Home, Forge, File, New repo, Prompt  remote   Remote, sign-in, devices
//   git      Git: issues, work, changes           inbox    Inbox
//   runtime  Runtime                             server   Server
//   service  what the Remote says when it refuses (service/*.ts)
//   sync     keeping in step: the browser's copy, sync, Home's settings

import base from './base.ts';
import git from './git.ts';
import inbox from './inbox.ts';
import pages from './pages.ts';
import remote from './remote.ts';
import runtime from './runtime.ts';
import shell from './shell.ts';
import server from './server.ts';
import service from './service.ts';
import sync from './sync.ts';

const parts: Record<string, string>[] = [shell, base, pages, remote, git, inbox, runtime, server, service, sync];
const ja: Record<string, string> = Object.assign({}, ...parts);
export default ja;
