// Bootstrap observations only, not execution or service-management authority.
// A named service in a diagnostic is not the bootstrap's completed marker.
export function hasReadinessLine(text,marker){
  if(marker==='console-ready')return /(?:^|\r?\n)console-ready\r?\n/.test(text);
  if(marker==='interactive-ready')return /(?:^|\r?\n)interactive-ready\r?\n/.test(text);
  throw new TypeError('known bootstrap readiness marker');
}
