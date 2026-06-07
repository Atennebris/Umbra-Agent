; umbra-asm — x86-64 Assembly (NASM syntax)
; Umbra CLI runtime stubs: task queue, syscall wrappers

; ── Constants ──────────────────────────────────────────────────────────────
%define SYS_WRITE    1
%define SYS_READ     0
%define SYS_EXIT     60
%define STDOUT_FD    1
%define STDERR_FD    2
%define TASK_LIMIT   256

MAX_STACK_DEPTH EQU 64
PAGE_SIZE       EQU 4096

; ── Macros ─────────────────────────────────────────────────────────────────
%macro PUSH_CALLEE_SAVED 0
    push rbx
    push r12
    push r13
    push r14
    push r15
%endmacro

%macro POP_CALLEE_SAVED 0
    pop r15
    pop r14
    pop r13
    pop r12
    pop rbx
%endmacro

%macro SYSCALL3 3
    mov rax, %1
    mov rdi, %2
    mov rsi, %3
    syscall
%endmacro

; ── External references ───────────────────────────────────────────────────
extern malloc
extern free
extern memcpy
extern printf

; ── Exported symbols ──────────────────────────────────────────────────────
global _start
global umbra_init
global umbra_run
global umbra_stop
global task_push
global task_pop
global task_count
global sys_write_str

; ── Data section ──────────────────────────────────────────────────────────
section .data
    banner      db  "Umbra CLI runtime v1.0", 0x0A, 0
    banner_len  equ $ - banner
    err_msg     db  "Error: task queue full", 0x0A, 0
    err_len     equ $ - err_msg

; ── BSS section ───────────────────────────────────────────────────────────
section .bss
    task_queue  resq TASK_LIMIT     ; task function pointers
    task_head   resq 1
    task_tail   resq 1
    task_size   resq 1
    heap_ptr    resq 1

; ── Code section ──────────────────────────────────────────────────────────
section .text

_start:
    call umbra_init
    test rax, rax
    jnz .error
    call umbra_run
    xor rdi, rdi
    mov rax, SYS_EXIT
    syscall
.error:
    mov rdi, 1
    mov rax, SYS_EXIT
    syscall

umbra_init:
    push rbp
    mov  rbp, rsp
    PUSH_CALLEE_SAVED
    ; zero task queue
    xor rax, rax
    mov qword [task_head], 0
    mov qword [task_tail], 0
    mov qword [task_size], 0
    ; print banner
    SYSCALL3 SYS_WRITE, STDOUT_FD, banner
    xor eax, eax
    POP_CALLEE_SAVED
    pop rbp
    ret

umbra_run:
    push rbp
    mov  rbp, rsp
.loop:
    call task_pop
    test rax, rax
    jz   .done
    call rax
    jmp  .loop
.done:
    xor eax, eax
    pop rbp
    ret

umbra_stop:
    push rbp
    mov  rbp, rsp
    mov qword [task_size], 0
    xor eax, eax
    pop rbp
    ret

task_push:
    ; rdi = function pointer
    push rbp
    mov  rbp, rsp
    mov  rax, [task_size]
    cmp  rax, TASK_LIMIT
    jge  .full
    mov  rcx, [task_tail]
    mov  [task_queue + rcx*8], rdi
    inc  rcx
    and  rcx, TASK_LIMIT-1
    mov  [task_tail], rcx
    inc  qword [task_size]
    xor  eax, eax
    pop  rbp
    ret
.full:
    mov eax, -1
    pop rbp
    ret

task_pop:
    push rbp
    mov  rbp, rsp
    xor  eax, eax
    cmp  qword [task_size], 0
    jz   .empty
    mov  rcx, [task_head]
    mov  rax, [task_queue + rcx*8]
    inc  rcx
    and  rcx, TASK_LIMIT-1
    mov  [task_head], rcx
    dec  qword [task_size]
.empty:
    pop rbp
    ret

task_count:
    mov rax, [task_size]
    ret

sys_write_str:
    ; rdi = fd, rsi = ptr, rdx = len
    mov rax, SYS_WRITE
    syscall
    ret
