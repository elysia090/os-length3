"""Inspect the live kernel stack in a portable x86 machine checkpoint."""

import argparse
from pathlib import Path
import struct

from kernel.x86 import REGISTER_NAMES, load_bzimage_kernel, read_virtual
from kernel.x86snapshot import load_x86_machine_state


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--stack-words', type=int, default=64)
    parser.add_argument('--stack-all', action='store_true')
    parser.add_argument('--registers', action='store_true')
    parser.add_argument('--code-address', type=lambda value: int(value, 0))
    parser.add_argument('--code-bytes', type=int, default=128)
    arguments = parser.parse_args(argv)

    image = arguments.bzimage.read_bytes()
    boot = load_bzimage_kernel(
        image, memory_bytes=arguments.memory_mib << 20)
    machine = load_x86_machine_state(
        arguments.checkpoint.read_bytes(), boot.state.memory)
    cpu = machine.cpu
    stack_words = max(0, arguments.stack_words)
    stack = read_virtual(cpu, cpu.register('rsp'), stack_words * 8)
    words = struct.unpack('<%dQ' % stack_words, stack) if stack_words else ()

    print('rip=0x%x rsp=0x%x pending=%s' % (
        cpu.rip, cpu.register('rsp'),
        None if machine.pending is None else machine.pending.operation))
    if arguments.registers:
        print(' '.join('%s=0x%x' % (name, cpu.register(name))
                       for name in REGISTER_NAMES))
    if arguments.code_address is not None:
        code = read_virtual(
            cpu, arguments.code_address, max(0, arguments.code_bytes),
            'execute')
        print('code[0x%x]=%s' % (arguments.code_address, code.hex()))
    for index, value in enumerate(words):
        if arguments.stack_all or value >= 0xffffffff80000000:
            print('%04x 0x%016x' % (index * 8, value))


if __name__ == '__main__':
    main()
