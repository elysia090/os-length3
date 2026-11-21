ENTRY(leaf)
PHDRS { ro PT_LOAD FILEHDR PHDRS FLAGS(4); code PT_LOAD FLAGS(5); data PT_LOAD FLAGS(6); stack PT_GNU_STACK FLAGS(6); }
SECTIONS {
 . = SIZEOF_HEADERS;
 .rodata : { *(.rodata) . = ALIGN(4096); } :ro
 .text : { *(.text) } :code
 . = ALIGN(4096);
 .data : { *(.data) . = ALIGN(4096); } :data
 /DISCARD/ : { *(*) }
}
