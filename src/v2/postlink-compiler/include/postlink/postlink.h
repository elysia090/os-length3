/* Public include for the standalone post-link compiler library.
 *
 * The individual headers remain usable by small consumers.  This aggregate is
 * the stable library boundary: a program can include one header, link
 * libpostlink.a, and know nothing about the repository's Python parity oracle,
 * JavaScript artifact reader, or diagnostic command-line tools.
 */

#ifndef POSTLINK_POSTLINK_H
#define POSTLINK_POSTLINK_H

#include <postlink/affine.h>
#include <postlink/block.h>
#include <postlink/boot.h>
#include <postlink/chain.h>
#include <postlink/closure.h>
#include <postlink/continuation.h>
#include <postlink/directory.h>
#include <postlink/delivery.h>
#include <postlink/deflate.h>
#include <postlink/dispatch.h>
#include <postlink/elf.h>
#include <postlink/entrymap.h>
#include <postlink/executable.h>
#include <postlink/format.h>
#include <postlink/index.h>
#include <postlink/instantiation.h>
#include <postlink/machine.h>
#include <postlink/opcodes.h>
#include <postlink/plan.h>
#include <postlink/physical.h>
#include <postlink/projection.h>
#include <postlink/residual.h>
#include <postlink/semantic.h>
#include <postlink/sha256.h>
#include <postlink/sweep.h>
#include <postlink/template.h>
#include <postlink/trace.h>
#include <postlink/transfer.h>
#include <postlink/wasm.h>
#include <postlink/x86.h>

#endif /* POSTLINK_POSTLINK_H */
