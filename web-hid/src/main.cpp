#include "secrets.h"
#include <WiFi.h>
#if WIFI_USE_ENTERPRISE
#include <esp_wifi.h>
#include <esp_wpa2.h>
#endif
#include <WebSocketsClient.h>
#include <string.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDMouse.h"

char WS_PATH[160];

USBHIDKeyboard Keyboard;
USBHIDMouse Mouse;
WebSocketsClient webSocket;

static const uint8_t FLAG_SEQ = 0x01;
static const uint8_t OP_KEY_DOWN = 1;
static const uint8_t OP_KEY_UP = 2;
static const uint8_t OP_RELEASE_ALL = 3;
static const uint8_t OP_MOUSE = 4;

static uint8_t mouseButtonsHeld = 0;

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

#if WIFI_USE_ENTERPRISE
  wifi_config_t config;
  memset(&config, 0, sizeof(config));
  strncpy((char *)config.sta.ssid, WIFI_SSID, sizeof(config.sta.ssid) - 1);
  strncpy((char *)config.sta.password, WIFI_PASSWORD, sizeof(config.sta.password) - 1);

  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_config(WIFI_IF_STA, &config);
  esp_wifi_sta_wpa2_ent_set_identity((uint8_t *)WIFI_USERNAME, strlen(WIFI_USERNAME));
  esp_wifi_sta_wpa2_ent_set_username((uint8_t *)WIFI_USERNAME, strlen(WIFI_USERNAME));
  esp_wifi_sta_wpa2_ent_set_password((uint8_t *)WIFI_PASSWORD, strlen(WIFI_PASSWORD));
  esp_wifi_sta_wpa2_ent_set_ca_cert(NULL, 0);
  esp_wifi_sta_wpa2_ent_enable();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#else
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#endif
}

static bool hidUsageAllowed(uint8_t usage) {
  if (usage >= 0xE0 && usage <= 0xE7) {
    return true;
  }
  return usage > 0 && usage < 0xA5;
}

static void releaseAllInput() {
  Keyboard.releaseAll();
  Mouse.release(MOUSE_ALL);
  mouseButtonsHeld = 0;
}

/** Arduino USBHIDMouse::move is int8_t; split 16-bit deltas. */
static void mouseMoveSplit(int16_t dx, int16_t dy, int8_t wheel) {
  bool wheelSent = false;
  while (dx != 0 || dy != 0 || !wheelSent) {
    int8_t sx = 0;
    int8_t sy = 0;
    if (dx > 127) {
      sx = 127;
    } else if (dx < -127) {
      sx = -127;
    } else {
      sx = (int8_t)dx;
    }
    if (dy > 127) {
      sy = 127;
    } else if (dy < -127) {
      sy = -127;
    } else {
      sy = (int8_t)dy;
    }
    const int8_t sw = wheelSent ? 0 : wheel;
    Mouse.move(sx, sy, sw);
    dx = (int16_t)(dx - sx);
    dy = (int16_t)(dy - sy);
    wheelSent = true;
    if (sx == 0 && sy == 0) {
      break;
    }
  }
}

static void syncMouseButtons(uint8_t buttons) {
  buttons &= 0x07;
  const uint8_t pressed = (uint8_t)(buttons & ~mouseButtonsHeld);
  const uint8_t released = (uint8_t)(mouseButtonsHeld & ~buttons);
  if (pressed & MOUSE_LEFT) {
    Mouse.press(MOUSE_LEFT);
  }
  if (pressed & MOUSE_RIGHT) {
    Mouse.press(MOUSE_RIGHT);
  }
  if (pressed & MOUSE_MIDDLE) {
    Mouse.press(MOUSE_MIDDLE);
  }
  if (released & MOUSE_LEFT) {
    Mouse.release(MOUSE_LEFT);
  }
  if (released & MOUSE_RIGHT) {
    Mouse.release(MOUSE_RIGHT);
  }
  if (released & MOUSE_MIDDLE) {
    Mouse.release(MOUSE_MIDDLE);
  }
  mouseButtonsHeld = buttons;
}

/**
 * Live binary contract (little-endian):
 *   op u8, flags u8 (bit0 = seq), seq u16
 *   op 1/2: + usage u8 (total 5)
 *   op 3: releaseAll (total 4)
 *   op 4: buttons u8, dx i16, dy i16, wheel i8 (total 10)
 */
static void applyBinaryHidFrame(uint8_t *payload, size_t length) {
  if (payload == nullptr || length < 4) {
    return;
  }
  const uint8_t op = payload[0];
  const uint8_t flags = payload[1];
  if ((flags & FLAG_SEQ) == 0) {
    return;
  }

  if (op == OP_RELEASE_ALL) {
    if (length != 4) {
      return;
    }
    releaseAllInput();
    return;
  }

  if (op == OP_MOUSE) {
    if (length != 10) {
      return;
    }
    const uint8_t buttons = payload[4];
    const int16_t dx = (int16_t)(payload[5] | (payload[6] << 8));
    const int16_t dy = (int16_t)(payload[7] | (payload[8] << 8));
    const int8_t wheel = (int8_t)payload[9];
    syncMouseButtons(buttons);
    if (dx != 0 || dy != 0 || wheel != 0) {
      mouseMoveSplit(dx, dy, wheel);
    }
    return;
  }

  if (op != OP_KEY_DOWN && op != OP_KEY_UP) {
    return;
  }
  if (length != 5) {
    return;
  }
  const uint8_t usage = payload[4];
  if (!hidUsageAllowed(usage)) {
    return;
  }
  if (op == OP_KEY_DOWN) {
    Keyboard.pressRaw(usage);
  } else {
    Keyboard.releaseRaw(usage);
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      webSocket.sendTXT("{\"type\":\"device_ready\"}");
      break;

    case WStype_BIN:
      applyBinaryHidFrame(payload, length);
      break;

    case WStype_TEXT:
      // Dump paste from POST /api/paste only
      if (length > 0 && length < 256) {
        char buf[257];
        memcpy(buf, payload, length);
        buf[length] = '\0';
        Keyboard.print(buf);
      }
      break;

    case WStype_DISCONNECTED:
      releaseAllInput();
      break;

    case WStype_ERROR:
      releaseAllInput();
      break;

    default:
      break;
  }
}

void setup() {
  snprintf(WS_PATH, sizeof(WS_PATH), "/ws/device?token=%s", DEVICE_TOKEN);

  Keyboard.begin();
  Mouse.begin();
  USB.begin();

  connectWifi();

  for (int i = 0; i < 80; i++) {
    if (WiFi.status() == WL_CONNECTED) {
      break;
    }
    delay(500);
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect();
    return;
  }

  if (WS_USE_SSL) {
    webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
  } else {
    webSocket.begin(WS_HOST, WS_PORT, WS_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(4000);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect();
    connectWifi();
    delay(2000);
    return;
  }

  webSocket.loop();
}
