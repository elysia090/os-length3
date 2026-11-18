// Offline project workloads: identical shell input for native and translated roots.
// These fixture files are commands under test, not dependencies of this host runner.
// Missing commands retain the '-' mark; package downloads have separate tests.
import {readFileSync} from 'node:fs';
const project = (name: string) => readFileSync(new URL(`./workloads/${name}.sh`,import.meta.url),'utf8');
export const LANGUAGE_LINES = [
  {uses:['c++'],line:project('cpp')},
  {uses:['python3'],line:project('python')},
  {uses:['node'],line:project('node')},
  {uses:['npm'],line:project('npm')},
  {uses:['rustc'],line:project('rust')},
  {uses:['cargo'],line:project('cargo')},
  {uses:['go','gofmt'],line:project('go')},
];
