ENTRY(_start)

PHDRS
{
    headers PT_LOAD FILEHDR PHDRS FLAGS(4);
    text PT_LOAD FLAGS(5);
    data PT_LOAD FLAGS(6);
    note PT_NOTE FLAGS(4);
}

SECTIONS
{
    . = 0x400000 + SIZEOF_HEADERS;
    .headers : { BYTE(0) } :headers

    . = 0x401000;
    .text : { *(.text.start) } :text

    . = 0x403000;
    .rodata : { *(.rodata.result) } :text
    .note.fixture : { *(.note.fixture) } :text :note

    . = 0x404000;
    .data : { *(.data.fixture) } :data

    .debug.padding 0 : { *(.debug.padding) }

    /DISCARD/ : { *(.comment) *(.note.GNU-stack) }
}
