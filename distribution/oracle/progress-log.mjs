// Diagnostic host output only. Native shell redirection may buffer until EOF;
// this explicit no-clobber sink makes complete progress rows visible at once.
import {openSync,writeSync,closeSync} from 'node:fs';
export function progressLog(file){
  const fd=file===undefined?undefined:openSync(file,'wx');let closed=false;
  return {
    write(row){
      if(closed)throw new Error('closed progress log');
      const encoded=JSON.stringify(row)+'\n';
      if(fd===undefined)console.error(encoded.trimEnd());
      else{
        const bytes=Buffer.from(encoded);let done=0;
        while(done<bytes.length){
          const written=writeSync(fd,bytes,done,bytes.length-done);
          if(!written)throw new Error('progress log made no write progress');done+=written;
        }
      }
    },
    close(){if(!closed){closed=true;if(fd!==undefined)closeSync(fd);}}
  };
}
