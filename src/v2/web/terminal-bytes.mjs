// Keyboard and ANSI terminal protocol only. Linux owns termios and signals.
export function terminalKey(event){
  if(event.altKey||event.metaKey)return null;
  if(event.ctrlKey){const c=event.key.toLowerCase();return c.length===1&&c>='a'&&c<='z'?String.fromCharCode(c.charCodeAt(0)-96):null;}
  const special={Enter:'\r',Backspace:'\x7f',Tab:'\t',Escape:'\x1b',ArrowUp:'\x1b[A',ArrowDown:'\x1b[B',ArrowRight:'\x1b[C',ArrowLeft:'\x1b[D',Home:'\x1b[H',End:'\x1b[F',Delete:'\x1b[3~'};
  return special[event.key]??(event.key.length===1?event.key:null);
}
export class TerminalReplies{
  constructor(size,reply){this.size=size;this.reply=reply;this.row=1;this.column=1;this.saved=[1,1];this.escape='';}
  feed(text){for(const c of text){
    const {rows,columns}=this.size();
    if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||rows>1000||columns<1||columns>1000)throw new Error('bounded terminal size');
    this.row=Math.min(this.row,rows);this.column=Math.min(this.column,columns);
    if(this.escape){this.escape+=c;
      if(this.escape.length>64){this.escape='';continue;}
      if(this.escape==='\x1b7'){this.saved=[this.row,this.column];this.escape='';continue;}
      if(this.escape==='\x1b8'){[this.row,this.column]=this.saved;this.escape='';continue;}
      if(this.escape.length===2&&c==='[')continue;
      if(this.escape.startsWith('\x1b[')&&/[0-9;]/.test(c))continue;
      if(this.escape.startsWith('\x1b[')){
        const args=this.escape.slice(2,-1).split(';').map(x=>Number(x)||1);
        if(c==='H'||c==='f'){this.row=Math.min(rows,args[0]);this.column=Math.min(columns,args[1]??1);}
        if(c==='n'&&this.escape==='\x1b[6n')this.reply(`\x1b[${this.row};${this.column}R`);
        if(c==='t'&&this.escape==='\x1b[18t')this.reply(`\x1b[8;${rows};${columns}t`);
      }
      this.escape='';continue;
    }
    if(c==='\x1b'){this.escape=c;continue;}
    if(c==='\r')this.column=1;
    else if(c==='\n')this.row=Math.min(rows,this.row+1);
    else if(c==='\b')this.column=Math.max(1,this.column-1);
    else if(c>=' '){if(this.column===columns){this.column=1;this.row=Math.min(rows,this.row+1);}else ++this.column;}
  }}
}
