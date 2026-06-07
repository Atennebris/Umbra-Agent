;; umbra-wasm — WebAssembly Text Format (WAT) example module
;; Demonstrates: functions, globals, memory, imports, exports, types

(module
  ;; --- Imports ---
  (import "env" "log_i32"   (func $log_i32   (param i32)))
  (import "env" "log_str"   (func $log_str   (param i32 i32)))
  (import "env" "memory"    (memory 1))

  ;; --- Type definitions ---
  (type $fn_unary  (func (param i32) (result i32)))
  (type $fn_binary (func (param i32 i32) (result i32)))

  ;; --- Global variables ---
  (global $counter    (mut i32) (i32.const 0))
  (global $max_iter   i32       (i32.const 1000))
  (global $version    i32       (i32.const 1))

  ;; --- Memory & data ---
  (memory 2)
  (data (i32.const 0) "UmbraWASM\00")

  ;; --- Table for indirect calls ---
  (table 4 funcref)
  (elem (i32.const 0) $add $subtract $multiply $factorial)

  ;; --- Functions ---
  (func $add (export "add")
    (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add)

  (func $subtract (export "subtract")
    (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.sub)

  (func $multiply (export "multiply")
    (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.mul)

  (func $factorial (export "factorial")
    (param $n i32) (result i32)
    (if (result i32)
      (i32.le_s (local.get $n) (i32.const 1))
      (then (i32.const 1))
      (else
        (i32.mul
          (local.get $n)
          (call $factorial (i32.sub (local.get $n) (i32.const 1)))))))

  (func $increment (export "increment")
    global.get $counter
    i32.const 1
    i32.add
    global.set $counter)

  (func $get_counter (export "getCounter") (result i32)
    global.get $counter)

  (func $clamp (export "clamp")
    (param $val i32) (param $lo i32) (param $hi i32) (result i32)
    (i32.min_s
      (i32.max_s (local.get $val) (local.get $lo))
      (local.get $hi)))

  ;; --- Explicit exports ---
  (export "memory"     (memory 0))
  (export "table"      (table 0))
  (export "counter"    (global $counter))
  (export "maxIter"    (global $max_iter))
)
