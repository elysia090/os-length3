ENTRY(physical_entry)

PHDRS
{
    headers PT_LOAD FILEHDR PHDRS FLAGS(4);
    text PT_LOAD FLAGS(5);
}

SECTIONS
{
    . = 0x400000 + SIZEOF_HEADERS;
    .headers : { BYTE(0) } :headers

    . = 0x500000;
    .text : AT(0x100000) { *(.text.start) *(.text.dead) } :text
    physical_entry = LOADADDR(.text) + (_start - ADDR(.text));

    .debug.padding 0 : { *(.debug.padding) }

    /DISCARD/ : { *(.comment) *(.note*) }
}
