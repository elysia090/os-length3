ENTRY(_start)
SECTIONS {
    . = 0x100000;
    .text : { *(.multiboot) *(.text) }
    .rodata : { *(.rodata) }
    .bss : { *(.bss) }
    /DISCARD/ : { *(.note*) *(.comment) }
}
