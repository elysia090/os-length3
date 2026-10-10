// The diagnostic selects observations on the product's sole C VM engine.
import {runMachine} from '../../../web/machine-runtime.mjs';
export function checkStartup(reader,provider,compiler,readExtent,options={}) {
  return runMachine(reader,provider,compiler,readExtent,{...options,diagnostic:true});
}
