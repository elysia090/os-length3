#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const here=fileURLToPath(new URL('.',import.meta.url)),base='sealed-parent';
const sealed=join(here,base,'ricebox-transfer-receipt-f0748b1');
const stager=join(here,base,'ricebox-static-shell-acceptance-f0748b1');
const stock=process.argv[2]??fileURLToPath(new URL('../browser/stock-chrome.ts',import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),'ricebox-static-tests-'));
try{
  const bytes=readFileSync(stock);
  if(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!=='6db7dd3f7583c3aa695a37ce0cb86d7068b80dbf'){
    throw Error('SELF_TEST_REQUIRES_EXACT_STOCK_CHROME_SOURCE');
  }
  copyFileSync(stock,join(temporary,'stock-chrome.ts'));
  for(const f of ['capture.mjs','origin.mjs','routes.mjs'])copyFileSync(join(sealed,f),join(temporary,f));
  copyFileSync(join(stager,'probe-site.mjs'),join(temporary,'probe-site.mjs'));
  for(const f of ['sandbox-same-process.mjs','sandbox-control.test.mjs','origin-control.test.mjs','probe-staged.mjs']){
    copyFileSync(join(here,f),join(temporary,f));
  }
  const tests=[
    join(here,'admission.test.mjs'),join(here,'presenter-control.test.mjs'),join(sealed,'receipt.test.mjs'),
    join(temporary,'sandbox-control.test.mjs'),join(temporary,'origin-control.test.mjs')
  ];
  execFileSync(process.execPath,['--experimental-vm-modules','--test',...tests],{stdio:'inherit'});
}finally{rmSync(temporary,{recursive:true,force:true})}
