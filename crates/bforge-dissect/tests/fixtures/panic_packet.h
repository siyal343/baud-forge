/*
 * A crash report from a Cortex-M target: a magic word and two addresses.
 * The addresses are 64-bit so a host-side image (base 0x140000000) fits too.
 */
#include <stdint.h>

struct __attribute__((packed)) PanicPacket {
    uint32_t magic;    /* 0..4   0xC0DEFEED */
    __le64   pc;       /* 4..12  program counter at the fault */
    __le64   lr;       /* 12..20 link register */
};
