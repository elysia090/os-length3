// The Japanese for every English text, gathered from each part of the OS.
// A part's file (ja-PART.ts) maps its English texts to Japanese; i18n.test.ts checks
// that every t('…') in the source has one.
//
//   shell    the rail and the person's menu      base     shared words and models
//   pages    Home, Forge, File, New repo, Prompt  remote   Remote, sign-in, devices
//   git      Git: issues, work, changes           inbox    Inbox
//   runtime  Runtime                             server   Server
//   service  what the Remote says when it refuses (remote/*.ts)
//   sync     keeping in step: the browser's copy, sync, Home's settings

import base from './ja-base.ts';
import git from './ja-git.ts';
import inbox from './ja-inbox.ts';
import pages from './ja-pages.ts';
import remote from './ja-remote.ts';
import runtime from './ja-runtime.ts';
import shell from './ja-shell.ts';
import server from './ja-server.ts';
import service from './ja-service.ts';
import sync from './ja-sync.ts';

const parts: Record<string, string>[] = [shell, base, pages, remote, git, inbox, runtime, server, service, sync];
const ja: Record<string, string> = Object.assign({}, ...parts);
export default ja;
