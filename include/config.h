#ifndef CONFIG_H
#define CONFIG_H

// ==================== WiFi Configuration ====================
#define WIFI_SSID          "Mani"
#define WIFI_PASSWORD      "nani7274"

// ==================== Backend Server Configuration ====================
#define SERVER_HOST        "10.122.106.43"
#define SERVER_PORT        3000
#define WS_PORT            3001              // WebSocket port

// ==================== Machine Credentials ====================
#define MACHINE_ID         "smart-door-001"
#define MACHINE_PASSWORD   "sd@nanim2026"

// ==================== ESP32 Main Controller Pins ==================== 
#define RELAY_PIN          13    // Relay control for solenoid lock
#define BUTTON_PIN         27    // Doorbell push button (active LOW, internal pull-up)
#define BUZZER_PIN         4     // Buzzer for doorbell sound

// ==================== I2S Microphone (INMP441) ====================
// Same pins as proven working Deepgram reference code
#define MIC_SCK_PIN        26    // I2S Clock (SCK/BCLK)
#define MIC_WS_PIN         25    // I2S Word Select (WS/LRCLK)
#define MIC_SD_PIN         33    // I2S Data In (SD/DOUT)

// ==================== I2S Speaker Amplifier (MAX98357A) ====================
#define SPK_BCLK_PIN       22    // I2S Bit Clock
#define SPK_LRC_PIN        21    // I2S Left/Right Clock
#define SPK_DIN_PIN        23    // I2S Data Out

// ==================== Audio Configuration ====================
#define AUDIO_SAMPLE_RATE  16000  // 16kHz for speech
#define RECORD_SECONDS     3      // Record duration after doorbell
#define RECORD_BUFFER_SIZE (AUDIO_SAMPLE_RATE * 2 * RECORD_SECONDS) // 96KB for 3s
#define BUZZER_CHANNEL     7      // LEDC channel for buzzer (avoid I2S conflict)
#define BUZZER_FREQ        2000   // Buzzer tone frequency Hz

// ==================== ESP-CAM (AI Thinker) ====================
// ESP-CAM only needs power (5V + GND), connects wirelessly via WiFi
#define FLASH_LED_PIN      4     // Built-in flash LED on ESP-CAM

// ==================== Timing Configuration ====================
#define DOOR_UNLOCK_TIME   5000  // Door stays unlocked for 5 seconds
#define WS_RECONNECT_TIME  5000  // WebSocket reconnect interval
#define HEARTBEAT_INTERVAL 10000 // Heartbeat every 10 seconds
#define BUTTON_COOLDOWN    3000  // Cooldown between doorbell presses
#define BUZZER_DURATION    1500  // Buzzer rings for 1.5 seconds
#define HOLD_THRESHOLD     500   // ms: hold longer than this = record mode

#endif // CONFIG_H
