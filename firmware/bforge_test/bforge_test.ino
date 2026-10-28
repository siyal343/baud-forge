/*
 * bforge_test: a serial test instrument for BaudForge.
 *
 * It is not a product sketch. It exists so that host tests can ask real firmware
 * for a known byte stream, and it runs on an ESP32-C3 over the built-in USB
 * serial port.
 *
 * Commands are one line each, ended by '\n'. Replies start with "OK" or "ERR".
 * While a mode is streaming, the sketch still reads commands, so "stop" always
 * works.
 *
 * Modes:
 *   text   printable lines, LF terminated        framing = delimiter 0x0A
 *   imu    packed 19-byte frame + CRC-32C, COBS   framing = cobs, crc32c
 *   sync   sync word AA 55, length u16be, CRC-16  framing = header_length
 *   prbs   PRBS-31 bulk bytes with a block header framing = none
 *
 * Every mode counts frames, so a host test can see a gap. The fault commands
 * corrupt, drop or shorten the next N frames, which is how host-side error paths
 * are tested against real bytes instead of a mock.
 */

#include <Arduino.h>

#define FIRMWARE_NAME "bforge_test"
#define FIRMWARE_VERSION "1.0.0"

// The Arduino preprocessor writes function prototypes above the first function, so
// every type a signature uses must be declared here and not further down.
typedef uint8_t Mode;
#define MODE_IDLE 0
#define MODE_TEXT 1
#define MODE_IMU 2
#define MODE_SYNC 3
#define MODE_PRBS 4

// ---------------------------------------------------------------- primitives

static uint8_t crc8_atm(const uint8_t *data, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++)
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

static uint16_t crc16_ccitt_false(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t bit = 0; bit < 8; bit++)
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

static uint32_t crc32c(const uint8_t *data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++)
      crc = (crc & 1u) ? ((crc >> 1) ^ 0x82F63B78u) : (crc >> 1);
  }
  return ~crc;
}

// COBS: no output byte is zero. The caller appends the delimiter.
static size_t cobs_encode(const uint8_t *in, size_t len, uint8_t *out) {
  size_t read = 0, write = 0;
  while (read < len) {
    size_t code_index = write++;
    uint8_t code = 1;
    while (read < len && in[read] != 0 && code != 0xFF) {
      out[write++] = in[read++];
      code++;
    }
    out[code_index] = code;
    if (read < len && in[read] == 0) read++;
  }
  return write;
}

// PRBS-31: x^31 + x^28 + 1. The seed must not be zero.
static uint32_t prbs_state = 0x7FFFFFFEu;

static uint8_t prbs_byte() {
  uint8_t value = 0;
  for (uint8_t bit = 0; bit < 8; bit++) {
    uint32_t feedback = ((prbs_state >> 30) ^ (prbs_state >> 27)) & 1u;
    prbs_state = ((prbs_state << 1) | feedback) & 0x7FFFFFFFu;
    value = (uint8_t)((value << 1) | feedback);
  }
  return value;
}

// ---------------------------------------------------------------- state

static Mode mode = MODE_IDLE;
static uint32_t rate_hz = 10;          // 0 means "as fast as the port allows"
static uint32_t next_due_us = 0;
static uint32_t sequence = 0;          // frames in the current mode
static uint32_t bad_crc_left = 0;
static uint32_t drop_left = 0;
static uint32_t truncate_left = 0;
static uint32_t silence_ms = 0;
static uint32_t silence_until_ms = 0;
static bool heartbeat = false;
static uint32_t heartbeat_due_ms = 0;

static char command[96];
static size_t command_len = 0;

// ---------------------------------------------------------------- output

static void write_bytes(const uint8_t *data, size_t len) { Serial.write(data, len); }

static void write_line(const char *text) {
  Serial.print(text);
  Serial.print('\n');
}

static void write_u32_line(const char *prefix, uint32_t value) {
  Serial.print(prefix);
  Serial.print(' ');
  Serial.print(value);
  Serial.print('\n');
}

// ---------------------------------------------------------------- frames

// 19-byte frame the host dissects with imu_packet.h, plus a 4-byte CRC-32C.
static size_t build_imu(uint8_t *frame, uint32_t seq) {
  uint32_t now_us = micros();
  frame[0] = 0x55;                       // sync 0xAA55, little endian
  frame[1] = 0xAA;
  frame[2] = 3;                          // version
  frame[3] = (uint8_t)((seq & 0x07) | (((seq >> 3) & 0x1F) << 3));  // flags, channel
  frame[4] = (uint8_t)(now_us);
  frame[5] = (uint8_t)(now_us >> 8);
  frame[6] = (uint8_t)(now_us >> 16);
  frame[7] = (uint8_t)(now_us >> 24);
  uint16_t millivolts = (uint16_t)(7400 + (seq % 800));
  frame[8] = (uint8_t)(millivolts >> 8); // big endian on the wire
  frame[9] = (uint8_t)(millivolts);
  float gyro = 0.001f * (float)(seq % 1000);
  memcpy(&frame[10], &gyro, 4);
  frame[14] = (uint8_t)(seq);            // samples carry the low sequence bytes,
  frame[15] = (uint8_t)(seq >> 8);       // so a host can prove no frame was lost
  frame[16] = 0x30;
  frame[17] = 0x40;
  frame[18] = 1;                         // mode = MODE_RUN

  uint32_t crc = crc32c(frame, 19);
  if (bad_crc_left > 0) {
    crc ^= 0x00000001u;
    bad_crc_left--;
  }
  frame[19] = (uint8_t)(crc);
  frame[20] = (uint8_t)(crc >> 8);
  frame[21] = (uint8_t)(crc >> 16);
  frame[22] = (uint8_t)(crc >> 24);
  return 23;
}

static void emit_imu() {
  uint8_t frame[64];
  size_t len = build_imu(frame, sequence);
  if (truncate_left > 0) {
    len -= 5;
    truncate_left--;
  }
  uint8_t encoded[96];
  size_t encoded_len = cobs_encode(frame, len, encoded);
  if (drop_left > 0) {
    drop_left--;
    return;
  }
  write_bytes(encoded, encoded_len);
  uint8_t delimiter = 0;
  write_bytes(&delimiter, 1);
  sequence++;
}

// Sync word AA 55, u16 big-endian length of the payload, payload, CRC-16.
static void emit_sync() {
  uint8_t frame[64];
  size_t payload_len = 8;
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = 0;
  frame[3] = (uint8_t)(payload_len + 2); // payload plus its own CRC-16
  frame[4] = (uint8_t)(sequence);
  frame[5] = (uint8_t)(sequence >> 8);
  frame[6] = (uint8_t)(sequence >> 16);
  frame[7] = (uint8_t)(sequence >> 24);
  for (size_t i = 0; i < 4; i++) frame[8 + i] = (uint8_t)(i * 17 + sequence);
  size_t body = 12;
  uint16_t crc = crc16_ccitt_false(frame + 4, body - 4);
  if (bad_crc_left > 0) {
    crc ^= 0x0001;
    bad_crc_left--;
  }
  frame[body++] = (uint8_t)(crc >> 8);
  frame[body++] = (uint8_t)(crc);

  if (truncate_left > 0) {
    body -= 4;
    truncate_left--;
  }
  if (drop_left > 0) {
    drop_left--;
    return;
  }
  write_bytes(frame, body);
  sequence++;
}

static void emit_text() {
  if (drop_left > 0) {
    drop_left--;
    return;
  }
  Serial.print("T ");
  Serial.print(millis());
  Serial.print(' ');
  Serial.print(sequence);
  Serial.print(' ');
  Serial.print((uint32_t)(sequence * 37u + 11u));
  Serial.print(" crc=");
  uint8_t payload[8];
  for (size_t i = 0; i < 8; i++) payload[i] = (uint8_t)(sequence + i);
  if (bad_crc_left > 0) {
    payload[0] ^= 0xFF;
    bad_crc_left--;
  }
  Serial.print(crc8_atm(payload, 8), HEX);
  Serial.print('\n');
  sequence++;
}

// PRBS bulk stream: a block header every 256 bytes, so a host can detect a gap.
static void emit_prbs() {
  uint8_t block[264];
  block[0] = 0xAA;
  block[1] = 0x55;
  block[2] = (uint8_t)(sequence);
  block[3] = (uint8_t)(sequence >> 8);
  block[4] = (uint8_t)(sequence >> 16);
  block[5] = (uint8_t)(sequence >> 24);
  block[6] = 0xC3;
  block[7] = block[2] ^ block[3] ^ block[4] ^ block[5];
  for (size_t i = 8; i < 256; i++) block[i] = prbs_byte();
  size_t len = 256;
  if (truncate_left > 0) {
    len -= 8;
    truncate_left--;
  }
  write_bytes(block, len);
  sequence++;
}

// ---------------------------------------------------------------- commands

static uint32_t parse_u32(const char *text, uint32_t fallback) {
  if (text == nullptr || *text == '\0') return fallback;
  return (uint32_t)strtoul(text, nullptr, 10);
}

static const char *mode_label(Mode value) {
  switch (value) {
    case MODE_TEXT: return "text";
    case MODE_IMU: return "imu";
    case MODE_SYNC: return "sync";
    case MODE_PRBS: return "prbs";
    default: return "idle";
  }
}

static void start_mode(Mode next, uint32_t hz) {
  mode = next;
  rate_hz = hz;
  sequence = 0;
  next_due_us = micros();
  Serial.print("OK mode ");
  Serial.print(mode_label(mode));
  Serial.print(' ');
  Serial.println(rate_hz);
}

static void handle_command(char *line) {
  char *verb = strtok(line, " ");
  if (verb == nullptr) return;

  if (strcmp(verb, "id") == 0) {
    Serial.print("OK id ");
    Serial.print(FIRMWARE_NAME);
    Serial.print(' ');
    Serial.print(FIRMWARE_VERSION);
    Serial.print(' ');
    Serial.print(ESP.getChipModel());
    Serial.print(' ');
    Serial.println(ESP.getCpuFreqMHz() * 1000000u);
  } else if (strcmp(verb, "help") == 0) {
    write_line("OK help id | hb on|off | mode text|imu|sync|prbs [hz] | stop");
    write_line("OK help silence <ms> | badcrc <n> | drop <n> | trunc <n> | rate <hz>");
  } else if (strcmp(verb, "hb") == 0) {
    char *value = strtok(nullptr, " ");
    heartbeat = value != nullptr && strcmp(value, "on") == 0;
    heartbeat_due_ms = millis();
    write_line(heartbeat ? "OK hb on" : "OK hb off");
  } else if (strcmp(verb, "mode") == 0) {
    char *name = strtok(nullptr, " ");
    char *hz = strtok(nullptr, " ");
    uint32_t parsed = parse_u32(hz, rate_hz);
    if (name == nullptr) {
      write_line("ERR mode needs text, imu, sync or prbs");
    } else if (strcmp(name, "text") == 0) {
      start_mode(MODE_TEXT, parsed);
    } else if (strcmp(name, "imu") == 0) {
      start_mode(MODE_IMU, parsed);
    } else if (strcmp(name, "sync") == 0) {
      start_mode(MODE_SYNC, parsed);
    } else if (strcmp(name, "prbs") == 0) {
      start_mode(MODE_PRBS, parsed);
    } else {
      write_line("ERR unknown mode");
    }
  } else if (strcmp(verb, "stop") == 0) {
    mode = MODE_IDLE;
    Serial.print("OK stop ");
    Serial.println(sequence);
  } else if (strcmp(verb, "silence") == 0) {
    silence_ms = parse_u32(strtok(nullptr, " "), 1000);
    silence_until_ms = millis() + silence_ms;
    write_u32_line("OK silence", silence_ms);
  } else if (strcmp(verb, "badcrc") == 0) {
    bad_crc_left = parse_u32(strtok(nullptr, " "), 1);
    write_u32_line("OK badcrc", bad_crc_left);
  } else if (strcmp(verb, "drop") == 0) {
    drop_left = parse_u32(strtok(nullptr, " "), 1);
    write_u32_line("OK drop", drop_left);
  } else if (strcmp(verb, "trunc") == 0) {
    truncate_left = parse_u32(strtok(nullptr, " "), 1);
    write_u32_line("OK trunc", truncate_left);
  } else if (strcmp(verb, "rate") == 0) {
    rate_hz = parse_u32(strtok(nullptr, " "), rate_hz);
    write_u32_line("OK rate", rate_hz);
  } else {
    Serial.print("ERR unknown command ");
    write_line(verb);
  }
}

// Read available bytes and act on every complete line.
static void poll_commands() {
  while (Serial.available() > 0) {
    char character = (char)Serial.read();
    if (character == '\r') continue;
    if (character == '\n') {
      command[command_len] = '\0';
      if (command_len > 0) handle_command(command);
      command_len = 0;
      continue;
    }
    if (character == 0x03) {  // Ctrl-C always stops
      mode = MODE_IDLE;
      command_len = 0;
      write_line("OK stop 0");
      continue;
    }
    if (command_len < sizeof(command) - 1) command[command_len++] = character;
  }
}

// ---------------------------------------------------------------- main loop

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.print("BOOT ");
  Serial.print(FIRMWARE_NAME);
  Serial.print(' ');
  Serial.print(FIRMWARE_VERSION);
  Serial.print(' ');
  Serial.println(ESP.getChipModel());
  write_line("OK ready");
}

void loop() {
  poll_commands();

  uint32_t now_ms = millis();
  if (heartbeat && now_ms >= heartbeat_due_ms) {
    heartbeat_due_ms = now_ms + 1000;
    Serial.print("HB ");
    Serial.print(now_ms);
    Serial.print(' ');
    Serial.println(sequence);
  }

  if (mode == MODE_IDLE) {
    delay(1);
    return;
  }
  if (now_ms < silence_until_ms) {
    delay(1);
    return;
  }

  if (rate_hz > 0) {
    uint32_t now_us = micros();
    if ((int32_t)(now_us - next_due_us) < 0) return;  // not due yet
    next_due_us += 1000000u / rate_hz;
  }

  switch (mode) {
    case MODE_TEXT: emit_text(); break;
    case MODE_IMU: emit_imu(); break;
    case MODE_SYNC: emit_sync(); break;
    case MODE_PRBS: emit_prbs(); break;
    default: break;
  }
}
