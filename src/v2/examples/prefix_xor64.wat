;; Inclusive prefix XOR of 64 bits, as wasm32.
;;
;; wasm has no carry-less multiply, so the scan is six shift/XOR doublings.
;; Pasted here, the listing is evaluated rather than pattern-matched, so the
;; same function comes back as a single instruction on a target that does have
;; one.
;; qm-input-bits: 64
(module
  (func $prefix_xor64_qm (export "prefix_xor64_qm") (param i64) (result i64)
    (local i64 i64 i64 i64 i64 i64)
    local.get 0
    local.get 0
    i64.const 0x1
    i64.shl
    i64.xor
    local.set 1
    local.get 1
    local.get 1
    i64.const 0x2
    i64.shl
    i64.xor
    local.set 2
    local.get 2
    local.get 2
    i64.const 0x4
    i64.shl
    i64.xor
    local.set 3
    local.get 3
    local.get 3
    i64.const 0x8
    i64.shl
    i64.xor
    local.set 4
    local.get 4
    local.get 4
    i64.const 0x10
    i64.shl
    i64.xor
    local.set 5
    local.get 5
    local.get 5
    i64.const 0x20
    i64.shl
    i64.xor
    local.set 6
    local.get 6
  )
)
