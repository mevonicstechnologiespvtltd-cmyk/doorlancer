/*
 * Doorlance - ESP32 Main Controller
 * Controls relay/solenoid lock, doorbell button, buzzer
 * INMP441 I2S microphone + MAX98357A I2S speaker for AI voice assistant & intercom
 * Communicates with backend via WebSocket
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <HTTPClient.h>
#include "config.h"
#include <driver/gpio.h>

// Deepgram API key for Speech-to-Text
#define DEEPGRAM_API_KEY "1e05fd3b54aa3343103484ac22b73921e24e76a1"
#define GAIN_BOOSTER 8    // INMP441 gain (32 was clipping; 8 is safe for normal speech)

WebSocketsClient webSocket;

bool doorLocked = true;
unsigned long lastHeartbeat = 0;
unsigned long doorUnlockTime = 0;
bool autoRelockPending = false;
unsigned long lastButtonPress = 0;
int lastButtonState = HIGH;
bool doorbellFlowActive = false;
unsigned long buttonPressStart = 0;  // when button was first pressed
bool buttonHeld = false;             // true while button is held down

// Pending owner-initiated audio (set from WS callback, played from main loop)
String pendingAudioUrl = "";
bool pendingAudioPlay = false;

// Pre-allocated audio buffer (must be allocated early before heap fragments)
int16_t *audioBuffer = nullptr;
int audioBufferMaxSamples = 0;

// Cached welcome audio URL (fetched once from backend)
String welcomeAudioUrl = "";

// Function declarations
void connectWiFi();
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length);
void handleCommand(const char *payload);
void lockDoor();
void unlockDoor();
void sendStatus();
void sendHeartbeat();
void checkDoorbell();
void sendDoorbellAlert();
void setupMic();
void setupSpeaker();
void buzzerOn();
void buzzerOff();
void handleDoorbellFlow();
String fetchWelcomeAudio();
int recordAudio(int16_t *buffer, int maxSamples, int durationMs);
String sendAudioToBackend(int16_t *samples, int numSamples);
void playAudioFromURL(const char *url);
void createWavHeader(uint8_t *header, int dataLen);
void testMic();
void testSpeaker();
String speechToTextDeepgram(int16_t *samples, int numSamples);
String sendTextToBackend(const char *transcript, const char *machineId);

// ==================== I2S Microphone Setup (INMP441) ====================
void setupMic() {
    i2s_config_t mic_cfg = {};
    mic_cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
    mic_cfg.sample_rate = AUDIO_SAMPLE_RATE;
    mic_cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    mic_cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    mic_cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    mic_cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    mic_cfg.dma_buf_count = 8;
    mic_cfg.dma_buf_len = 1024;
    mic_cfg.use_apll = false;

    i2s_pin_config_t mic_pins = {};
    mic_pins.mck_io_num = I2S_PIN_NO_CHANGE;  // MAX98357A / INMP441 don't need MCLK
    mic_pins.bck_io_num = MIC_SCK_PIN;
    mic_pins.ws_io_num = MIC_WS_PIN;
    mic_pins.data_out_num = I2S_PIN_NO_CHANGE;
    mic_pins.data_in_num = MIC_SD_PIN;

    esp_err_t err = i2s_driver_install(I2S_NUM_0, &mic_cfg, 0, NULL);
    if (err != ESP_OK) {
        Serial.printf("[MIC] I2S install failed: %d\n", err);
        return;
    }
    i2s_set_pin(I2S_NUM_0, &mic_pins);
    i2s_zero_dma_buffer(I2S_NUM_0);
    Serial.println("[MIC] INMP441 ready on I2S0");
}

// ==================== I2S Speaker Setup (MAX98357A) on I2S_NUM_1 ====================
void setupSpeaker() {
    Serial.printf("[SPK] MAX98357A pins: BCLK=%d, LRC=%d, DIN=%d\n", SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN);

    i2s_config_t spk_cfg = {};
    spk_cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    spk_cfg.sample_rate = AUDIO_SAMPLE_RATE;
    spk_cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    spk_cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    spk_cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    spk_cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    // Larger DMA pool: 16 buffers × 1024 samples = 16384 samples ≈ 1.0s @ 16kHz mono
    // Gives the network enough cushion to refill during slow Wi-Fi reads -> no breakups
    spk_cfg.dma_buf_count = 16;
    spk_cfg.dma_buf_len = 1024;
    spk_cfg.use_apll = false;  // MUST be false when WiFi is active (they share the PLL)
    spk_cfg.tx_desc_auto_clear = true;

    i2s_pin_config_t spk_pins = {};
    spk_pins.mck_io_num = I2S_PIN_NO_CHANGE;  // MAX98357A doesn't need MCLK
    spk_pins.bck_io_num = SPK_BCLK_PIN;
    spk_pins.ws_io_num = SPK_LRC_PIN;
    spk_pins.data_out_num = SPK_DIN_PIN;
    spk_pins.data_in_num = I2S_PIN_NO_CHANGE;

    esp_err_t err = i2s_driver_install(I2S_NUM_1, &spk_cfg, 0, NULL);
    if (err != ESP_OK) {
        Serial.printf("[SPK] I2S_NUM_1 install failed: %d\n", err);
        return;
    }
    i2s_set_pin(I2S_NUM_1, &spk_pins);
    i2s_zero_dma_buffer(I2S_NUM_1);
    Serial.println("[SPK] MAX98357A ready on I2S1");
}

// ==================== HARDWARE TEST: Microphone ====================
void testMic() {
    Serial.println("\n[TEST] ===== MICROPHONE TEST =====");
    Serial.printf("[TEST] Pins: SCK=%d, WS=%d, SD=%d\n", MIC_SCK_PIN, MIC_WS_PIN, MIC_SD_PIN);

    // Read 16-bit samples directly
    int16_t raw[256];
    size_t bytesRead = 0;

    // Flush first
    i2s_read(I2S_NUM_0, raw, sizeof(raw), &bytesRead, pdMS_TO_TICKS(200));
    delay(100);

    // Read actual samples
    esp_err_t err = i2s_read(I2S_NUM_0, raw, sizeof(raw), &bytesRead, pdMS_TO_TICKS(500));
    int count = bytesRead / 2;

    Serial.printf("[TEST] i2s_read returned: err=%d, bytesRead=%d, samples=%d\n", err, bytesRead, count);
    Serial.println("[TEST] First 20 raw 16-bit values from INMP441:");
    int16_t minVal = INT16_MAX, maxVal = INT16_MIN;
    for (int i = 0; i < min(count, 20); i++) {
        int16_t boosted = (int16_t)constrain((int32_t)raw[i] * GAIN_BOOSTER, -32768, 32767);
        Serial.printf("[TEST]   [%d] raw=%d  boosted=%d\n", i, raw[i], boosted);
        if (raw[i] < minVal) minVal = raw[i];
        if (raw[i] > maxVal) maxVal = raw[i];
    }
    Serial.printf("[TEST] Min=%d, Max=%d, Range=%d\n", minVal, maxVal, maxVal - minVal);

    if (maxVal == 0 && minVal == 0) {
        Serial.println("[TEST] ** ALL ZEROS - Mic not working! Check wiring:");
        Serial.println("[TEST]    VDD -> 3.3V");
        Serial.println("[TEST]    GND -> GND");
        Serial.printf("[TEST]    SCK -> GPIO%d\n", MIC_SCK_PIN);
        Serial.printf("[TEST]    WS  -> GPIO%d\n", MIC_WS_PIN);
        Serial.printf("[TEST]    SD  -> GPIO%d\n", MIC_SD_PIN);
        Serial.println("[TEST]    L/R -> GND (for left channel)");
    } else {
        Serial.println("[TEST] ** Mic is working! Non-zero data detected.");
    }
    Serial.println("[TEST] ===== MIC TEST END =====\n");
}

// ==================== HARDWARE TEST: Speaker ====================
void testSpeaker() {
    Serial.println("\n[TEST] ===== SPEAKER TEST =====");
    Serial.printf("[TEST] Pins: BCLK=%d, LRC=%d, DIN=%d\n", SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN);

    i2s_zero_dma_buffer(I2S_NUM_1);

    Serial.println("[TEST] Playing 1kHz tone for 2 seconds (mono ONLY_LEFT)...");
    Serial.println("[TEST] ** If you hear a clear tone, speaker wiring is OK! **");

    const int sampleRate = 16000;
    const float freq = 1000.0;
    int16_t samples[256];
    size_t bytesWritten;

    unsigned long start = millis();
    while (millis() - start < 2000) {
        for (int i = 0; i < 256; i++) {
            float t = (float)((millis() - start) * sampleRate / 1000 + i) / sampleRate;
            samples[i] = (int16_t)(30000.0 * sinf(2.0 * M_PI * freq * t));
        }
        i2s_write(I2S_NUM_1, samples, sizeof(samples), &bytesWritten, pdMS_TO_TICKS(100));
    }

    // Silence
    memset(samples, 0, sizeof(samples));
    i2s_write(I2S_NUM_1, samples, sizeof(samples), &bytesWritten, pdMS_TO_TICKS(100));

    // Keep I2S running — tx_desc_auto_clear=true fills idle DMA with zeros (silence).
    // NEVER call i2s_stop() here: stopping then re-starting the legacy I2S driver
    // can leave the DMA engine in a broken state where i2s_write() blocks forever.
    i2s_zero_dma_buffer(I2S_NUM_1);

    Serial.println("[TEST] ===== SPEAKER TEST END =====\n");
}

// ==================== Record Audio from INMP441 (16-bit mode) ====================
int recordAudio(int16_t *buffer, int maxSamples, int durationMs) {
    int recorded = 0;
    unsigned long start = millis();
    int32_t peakLevel = 0;

    // Flush stale DMA data
    int16_t flush[256];
    size_t discard;
    i2s_read(I2S_NUM_0, flush, sizeof(flush), &discard, pdMS_TO_TICKS(100));
    delay(50);

    Serial.println("[MIC] >> Speak now! Recording...");

    while (millis() - start < (unsigned long)durationMs && recorded < maxSamples) {
        int16_t tempBuf[512];
        int samplesToRead = min(512, maxSamples - recorded);
        size_t bytesRead = 0;
        esp_err_t err = i2s_read(I2S_NUM_0, tempBuf, samplesToRead * sizeof(int16_t), &bytesRead, pdMS_TO_TICKS(100));
        if (err == ESP_OK && bytesRead > 0) {
            int samplesGot = bytesRead / sizeof(int16_t);
            for (int i = 0; i < samplesGot && recorded < maxSamples; i++) {
                // Apply gain boost (INMP441 output is very quiet)
                int32_t val = (int32_t)tempBuf[i] * GAIN_BOOSTER;
                if (val > 32767) val = 32767;
                if (val < -32768) val = -32768;
                buffer[recorded] = (int16_t)val;
                int32_t absSample = abs(val);
                if (absSample > peakLevel) peakLevel = absSample;
                recorded++;
            }
        }
        // Print progress every second
        unsigned long elapsed = millis() - start;
        if (elapsed % 1000 < 20) {
            Serial.printf("[MIC] Recording... %lus peak=%ld samples=%d\n",
                elapsed / 1000, peakLevel, recorded);
        }
    }

    Serial.printf("[MIC] Recording done: %d samples, peak level: %ld\n", recorded, peakLevel);
    if (peakLevel < 100) {
        Serial.println("[MIC] WARNING: Very low audio level! Check INMP441 wiring.");
    }
    return recorded;
}

// ==================== Record Audio While Button Held ====================
int recordAudioWhileHeld(int16_t *buffer, int maxSamples) {
    int recorded = 0;
    int32_t peakLevel = 0;

    // Flush stale DMA data
    int16_t flush[256];
    size_t discard;
    i2s_read(I2S_NUM_0, flush, sizeof(flush), &discard, pdMS_TO_TICKS(100));
    delay(50);

    Serial.println("[MIC] >> Recording while button held...");
    unsigned long startTime = millis();

    while (digitalRead(BUTTON_PIN) == LOW && recorded < maxSamples) {
        webSocket.loop();  // keep WS alive while recording
        int16_t tempBuf[512];
        int samplesToRead = min(512, maxSamples - recorded);
        size_t bytesRead = 0;
        esp_err_t err = i2s_read(I2S_NUM_0, tempBuf, samplesToRead * sizeof(int16_t), &bytesRead, pdMS_TO_TICKS(100));
        if (err == ESP_OK && bytesRead > 0) {
            int samplesGot = bytesRead / sizeof(int16_t);
            for (int i = 0; i < samplesGot && recorded < maxSamples; i++) {
                int32_t val = (int32_t)tempBuf[i] * GAIN_BOOSTER;
                if (val > 32767) val = 32767;
                if (val < -32768) val = -32768;
                buffer[recorded] = (int16_t)val;
                int32_t absSample = abs(val);
                if (absSample > peakLevel) peakLevel = absSample;
                recorded++;
            }
        }
        unsigned long elapsed = millis() - startTime;
        if (elapsed % 1000 < 20) {
            Serial.printf("[MIC] Recording... %lus peak=%ld samples=%d\n",
                elapsed / 1000, peakLevel, recorded);
        }
    }

    Serial.printf("[MIC] Button released. Recorded %d samples (%.1fs), peak: %ld\n",
        recorded, (float)recorded / AUDIO_SAMPLE_RATE, peakLevel);
    if (peakLevel < 100) {
        Serial.println("[MIC] WARNING: Very low audio level! Check INMP441 wiring.");
    }
    return recorded;
}

// ==================== Create WAV Header ====================
void createWavHeader(uint8_t *header, int dataLen) {
    int sr = AUDIO_SAMPLE_RATE;
    int byteRate = sr * 2;  // 16-bit mono
    int fileSize = dataLen + 36;

    memcpy(header, "RIFF", 4);
    header[4] = fileSize; header[5] = fileSize >> 8;
    header[6] = fileSize >> 16; header[7] = fileSize >> 24;
    memcpy(header + 8, "WAVE", 4);
    memcpy(header + 12, "fmt ", 4);
    header[16] = 16; header[17] = header[18] = header[19] = 0;
    header[20] = 1; header[21] = 0;  // PCM
    header[22] = 1; header[23] = 0;  // Mono
    header[24] = sr; header[25] = sr >> 8;
    header[26] = sr >> 16; header[27] = sr >> 24;
    header[28] = byteRate; header[29] = byteRate >> 8;
    header[30] = byteRate >> 16; header[31] = byteRate >> 24;
    header[32] = 2; header[33] = 0;  // Block align
    header[34] = 16; header[35] = 0; // Bits per sample
    memcpy(header + 36, "data", 4);
    header[40] = dataLen; header[41] = dataLen >> 8;
    header[42] = dataLen >> 16; header[43] = dataLen >> 24;
}

// ==================== Send Audio to Backend ====================
String sendAudioToBackend(int16_t *samples, int numSamples) {
    int pcmLen = numSamples * 2;
    Serial.printf("[VOICE] Sending %d bytes to backend...\n", pcmLen);

    WiFiClient client;
    if (!client.connect(SERVER_HOST, SERVER_PORT, 10000)) {
        Serial.println("[VOICE] Connection failed");
        return "";
    }

    uint8_t wavHeader[44];
    createWavHeader(wavHeader, pcmLen);
    int totalLen = 44 + pcmLen;

    // Manual HTTP POST to avoid double-buffering 128KB
    client.printf("POST /api/voice/doorbell?machineId=%s HTTP/1.1\r\n", MACHINE_ID);
    client.printf("Host: %s:%d\r\n", SERVER_HOST, SERVER_PORT);
    client.println("Content-Type: audio/wav");
    client.printf("Content-Length: %d\r\n", totalLen);
    client.println("Connection: close");
    client.println();

    // Send WAV header
    client.write(wavHeader, 44);

    // Send PCM data in 4KB chunks
    uint8_t *pcmBytes = (uint8_t *)samples;
    int sent = 0;
    while (sent < pcmLen) {
        int chunk = min(4096, pcmLen - sent);
        size_t written = client.write(pcmBytes + sent, chunk);
        if (written == 0) break;
        sent += written;
    }
    Serial.printf("[VOICE] Sent %d/%d bytes\n", sent + 44, totalLen);

    // Wait for response (STT + AI + TTS can take 10-20s)
    unsigned long timeout = millis() + 45000;

    // Wait for first byte from server
    Serial.println("[VOICE] Waiting for backend response...");
    while (!client.available() && client.connected() && millis() < timeout) {
        webSocket.loop();  // keep WS alive during long HTTP wait
        delay(10);
    }

    if (!client.available()) {
        Serial.println("[VOICE] Timeout waiting for response");
        client.stop();
        return "";
    }

    // Read entire response
    String response = "";
    while (millis() < timeout) {
        if (client.available()) {
            response += (char)client.read();
        } else if (!client.connected()) {
            break;
        } else {
            webSocket.loop();  // keep WS alive while reading response
            delay(5);
        }
    }
    client.stop();

    Serial.printf("[VOICE] Raw response length: %d\n", response.length());

    // Find JSON body after headers
    int bodyStart = response.indexOf("\r\n\r\n");
    if (bodyStart < 0) {
        bodyStart = response.indexOf("\n\n");
        if (bodyStart >= 0) bodyStart += 2;
    } else {
        bodyStart += 4;
    }

    if (bodyStart < 0 || bodyStart >= (int)response.length()) {
        Serial.println("[VOICE] Could not find body in response");
        return "";
    }

    String body = response.substring(bodyStart);
    body.trim();

    if (body.length() == 0) {
        Serial.println("[VOICE] Empty response");
        return "";
    }

    Serial.printf("[VOICE] Body: %s\n", body.c_str());

    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, body)) {
        Serial.println("[VOICE] JSON parse error");
        return "";
    }

    const char *transcript = doc["transcript"] | "";
    const char *aiReply = doc["response"] | "";
    const char *audioUrl = doc["audioUrl"] | "";
    const char *pcmUrl = doc["pcmUrl"] | "";

    Serial.printf("[VOICE] Visitor said: \"%s\"\n", transcript);
    Serial.printf("[VOICE] AI response: \"%s\"\n", aiReply);

    // Prefer PCM for raw I2S playback
    const char *bestUrl = (strlen(pcmUrl) > 0) ? pcmUrl : audioUrl;
    if (strlen(bestUrl) > 0) {
        return String("http://") + SERVER_HOST + ":" + SERVER_PORT + bestUrl;
    }
    return "";
}

// ==================== Deepgram Speech-to-Text (on ESP32) ====================
// Sends WAV audio directly to Deepgram API via HTTPS, returns transcript text.
// Based on working reference code (techiesms/Speech-to-Text---Deepgram)
String speechToTextDeepgram(int16_t *samples, int numSamples) {
    Serial.println("[STT] Sending audio to Deepgram...");
    Serial.printf("[STT] Samples: %d, Free heap: %d\n", numSamples, ESP.getFreeHeap());

    int pcmBytes = numSamples * sizeof(int16_t);
    int totalWavBytes = 44 + pcmBytes;

    // Build WAV header
    uint8_t wavHeader[44];
    createWavHeader(wavHeader, pcmBytes);

    // Connect to Deepgram via TLS
    WiFiClientSecure sslClient;
    sslClient.setInsecure(); // Skip certificate verification (ESP32 has limited CA store)

    uint32_t t_start = millis();
    if (!sslClient.connect("api.deepgram.com", 443)) {
        Serial.println("[STT] SSL connection to Deepgram FAILED!");
        sslClient.stop();
        return "";
    }
    Serial.printf("[STT] Connected to Deepgram (%lums)\n", millis() - t_start);

    // Flush any pending data
    while (sslClient.available()) { sslClient.read(); }

    // Send HTTPS POST request
    String params = "?model=nova-2-general&language=en&smart_format=true";
    sslClient.println("POST /v1/listen" + params + " HTTP/1.1");
    sslClient.println("Host: api.deepgram.com");
    sslClient.println("Authorization: Token " + String(DEEPGRAM_API_KEY));
    sslClient.println("Content-Type: audio/wav");
    sslClient.println("Content-Length: " + String(totalWavBytes));
    sslClient.println("Connection: close");
    sslClient.println();

    // Send WAV header
    sslClient.write(wavHeader, 44);

    // Send PCM data in 1KB chunks
    uint8_t *pcmData = (uint8_t *)samples;
    size_t sent = 0;
    while (sent < (size_t)pcmBytes) {
        size_t toSend = min((size_t)1024, (size_t)pcmBytes - sent);
        sslClient.write(pcmData + sent, toSend);
        sent += toSend;
    }
    Serial.printf("[STT] Sent %d bytes (WAV: %d)\n", sent + 44, totalWavBytes);

    // Wait for response
    Serial.print("[STT] Waiting for transcription");
    String response = "";
    unsigned long timeout = millis() + 15000;

    while (response.length() == 0 && millis() < timeout) {
        while (sslClient.available()) {
            char c = sslClient.read();
            response += c;
        }
        if (response.length() == 0) {
            Serial.print(".");
            delay(100);
        }
    }
    Serial.println();
    sslClient.stop();

    if (response.length() == 0) {
        Serial.println("[STT] TIMEOUT! No response from Deepgram.");
        return "";
    }

    // Find JSON body after HTTP headers
    int bodyStart = response.indexOf("\r\n\r\n");
    if (bodyStart < 0) bodyStart = response.indexOf("\n\n");
    if (bodyStart < 0) {
        Serial.println("[STT] Could not find response body");
        return "";
    }
    bodyStart += (response.charAt(bodyStart) == '\r') ? 4 : 2;
    String body = response.substring(bodyStart);

    // Extract transcript from Deepgram JSON
    // Look for "transcript":"..." in the response
    int tIdx = body.indexOf("\"transcript\":\"");
    if (tIdx < 0) {
        Serial.println("[STT] No transcript found in response");
        Serial.printf("[STT] Response body: %.200s\n", body.c_str());
        return "";
    }
    tIdx += 14; // skip past "transcript":"
    int tEnd = body.indexOf("\"", tIdx);
    if (tEnd < 0) return "";

    String transcript = body.substring(tIdx, tEnd);
    Serial.printf("[STT] Deepgram transcript: \"%s\"\n", transcript.c_str());
    Serial.printf("[STT] Total time: %.1fs\n", (millis() - t_start) / 1000.0);

    return transcript;
}

// ==================== Send Transcript Text to Backend for AI + TTS ====================
// Sends visitor's spoken text to backend, gets AI response + TTS PCM audio URL
String sendTextToBackend(const char *transcript, const char *machineId) {
    Serial.printf("[VOICE] Sending transcript to backend: \"%s\"\n", transcript);

    WiFiClient client;
    HTTPClient http;
    String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/voice/doorbell-text";
    http.begin(client, url);
    http.setTimeout(30000);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<512> reqDoc;
    reqDoc["text"] = transcript;
    reqDoc["machineId"] = machineId;
    String reqBody;
    serializeJson(reqDoc, reqBody);

    int httpCode = http.POST(reqBody);
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("[VOICE] Backend error: %d\n", httpCode);
        http.end();
        return "";
    }

    String respBody = http.getString();
    http.end();

    Serial.printf("[VOICE] Backend response: %s\n", respBody.c_str());

    StaticJsonDocument<1024> respDoc;
    if (deserializeJson(respDoc, respBody)) {
        Serial.println("[VOICE] JSON parse error");
        return "";
    }

    const char *aiReply = respDoc["response"] | "";
    const char *pcmUrl = respDoc["pcmUrl"] | "";
    const char *audioUrl = respDoc["audioUrl"] | "";

    Serial.printf("[VOICE] AI response: \"%s\"\n", aiReply);

    const char *bestUrl = (strlen(pcmUrl) > 0) ? pcmUrl : audioUrl;
    if (strlen(bestUrl) > 0) {
        return String("http://") + SERVER_HOST + ":" + SERVER_PORT + bestUrl;
    }
    return "";
}

// ==================== Play Raw PCM from HTTP URL via I2S_NUM_1 ====================
// Streams mono 16-bit @ AUDIO_SAMPLE_RATE PCM in small chunks: download a chunk,
// normalize to near full-scale, write straight to I2S, repeat. The DMA pool is
// large enough (~1s) to absorb network jitter so audio never breaks.
void playAudioFromURL(const char *url) {
    Serial.printf("[SPK] Playing: %s\n", url);
    Serial.printf("[SPK] Free heap: %dKB\n", ESP.getFreeHeap() / 1024);

    if (!audioBuffer) {
        Serial.println("[SPK] ERROR: audioBuffer is null!");
        return;
    }

    WiFiClient client;
    HTTPClient http;
    http.begin(client, url);
    http.setTimeout(15000);
    http.setReuse(true);
    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("[SPK] HTTP error: %d\n", httpCode);
        http.end();
        return;
    }

    int fileSize = http.getSize();
    if (fileSize < 0) {
        // No Content-Length header (chunked transfer) — stream until connection closes
        Serial.printf("[SPK] No Content-Length, will stream until EOF\n");
        fileSize = 2000000; // large sentinel; streaming loop exits when stream closes
    } else if (fileSize == 0 || fileSize > 2000000) {
        Serial.printf("[SPK] Bad size (%d), aborting\n", fileSize);
        http.end();
        return;
    }
    Serial.printf("[SPK] Size: %d bytes (%.1fs)\n", fileSize, fileSize / 32000.0);

    WiFiClient *stream = http.getStreamPtr();

    // Small streaming chunk (4 KB = 2048 samples ≈ 128ms @ 16kHz)
    // Multiple of these fit inside the DMA pool, so I2S keeps playing while we read.
    const int CHUNK_BYTES = 4096;
    uint8_t *buf = (uint8_t *)audioBuffer;

    // I2S_NUM_1 is always running (never stopped after setupSpeaker).
    // Just flush any stale data before starting fresh audio.
    i2s_zero_dma_buffer(I2S_NUM_1);

    // Pre-buffer: download some audio first so DMA never starts empty.
    // 12 KB = ~375 ms head start before playback begins.
    const int PREBUFFER_BYTES = 12288;
    int preFilled = 0;
    unsigned long preDeadline = millis() + 5000;
    while (preFilled < PREBUFFER_BYTES && preFilled < fileSize && millis() < preDeadline) {
        if (stream->available()) {
            int got = stream->read(buf + preFilled, PREBUFFER_BYTES - preFilled);
            if (got > 0) preFilled += got;
        } else if (!stream->connected()) {
            break;
        } else {
            webSocket.loop();  // keep WS alive during audio pre-buffer
            delay(1);
        }
    }

    int totalPlayed = 0;
    int totalDownloaded = preFilled;
    unsigned long playStart = millis();
    int chunkNum = 0;

    auto normalizeAndWrite = [&](uint8_t *data, int byteLen) {
        byteLen &= ~1; // even = full 16-bit samples
        if (byteLen < 2) return;
        int numSamples = byteLen / 2;
        int16_t *samples = (int16_t *)data;

        // Find peak amplitude
        int16_t peak = 0;
        for (int i = 0; i < numSamples; i++) {
            int16_t v = samples[i];
            int16_t a = v < 0 ? -v : v;
            if (a > peak) peak = a;
        }

        // Only normalize chunks with real speech content (peak > 2000 avoids boosting noise floor)
        // Max 5x gain — TTS audio is already loud enough; high gain amplifies noise badly
        if (peak > 2000) {
            int32_t gain = (26000L * 256) / peak; // target 80% full scale, fixed-point 8.8
            if (gain > 5 * 256) gain = 5 * 256;   // cap at 5x — prevents noise amplification
            if (gain < 256) gain = 256;             // min 1x
            for (int i = 0; i < numSamples; i++) {
                int32_t val = ((int32_t)samples[i] * gain) >> 8;
                if (val > 32767) val = 32767;
                if (val < -32768) val = -32768;
                samples[i] = (int16_t)val;
            }
            if (chunkNum == 0) {
                Serial.printf("[SPK] Gain: %.1fx (peak %d -> ~26000)\n", gain / 256.0, peak);
            }
        }

        // Push to I2S (blocks while DMA is full — that's fine, no break)
        int offset = 0;
        size_t bytesWritten;
        while (offset < byteLen) {
            int chunk = byteLen - offset;
            if (chunk > 2048) chunk = 2048;
            i2s_write(I2S_NUM_1, data + offset, chunk, &bytesWritten, pdMS_TO_TICKS(2000));
            if (bytesWritten == 0) break;  // safety: DMA stalled, don't loop forever
            offset += bytesWritten;
        }
        totalPlayed += byteLen;
        chunkNum++;
    };

    // Play whatever was pre-buffered
    if (preFilled > 0) {
        normalizeAndWrite(buf, preFilled);
    }

    // Now stream the rest, chunk by chunk
    while (totalDownloaded < fileSize) {
        int wantBytes = fileSize - totalDownloaded;
        if (wantBytes > CHUNK_BYTES) wantBytes = CHUNK_BYTES;

        int downloaded = 0;
        unsigned long dlTimeout = millis() + 5000;
        while (downloaded < wantBytes && millis() < dlTimeout) {
            if (stream->available()) {
                int bytes = stream->read(buf + downloaded, wantBytes - downloaded);
                if (bytes > 0) downloaded += bytes;
            } else if (!stream->connected()) {
                break;
            } else {
                webSocket.loop();  // keep WS alive during chunk download
                delay(1);
            }
        }
        totalDownloaded += downloaded;

        if (downloaded < 2) break;
        normalizeAndWrite(buf, downloaded);
    }

    http.end();

    // Flush silence so the last samples reach the speaker before we stop
    uint8_t silence[2048] = {0};
    size_t bytesWritten;
    i2s_write(I2S_NUM_1, silence, sizeof(silence), &bytesWritten, pdMS_TO_TICKS(500));
    i2s_write(I2S_NUM_1, silence, sizeof(silence), &bytesWritten, pdMS_TO_TICKS(500));
    delay(80);

    // Keep I2S running — auto-clears to zeros (silence) between clips.
    i2s_zero_dma_buffer(I2S_NUM_1);

    unsigned long duration = millis() - playStart;
    Serial.printf("[SPK] Done. Played %d bytes in %lums (%d chunks). Heap: %dKB\n",
        totalPlayed, duration, chunkNum, ESP.getFreeHeap() / 1024);

    memset(audioBuffer, 0, audioBufferMaxSamples * sizeof(int16_t));
}

// ==================== Buzzer using LEDC (avoids I2S conflict) ====================
void buzzerOn() {
    ledcAttach(BUZZER_PIN, BUZZER_FREQ, 8);  // new ESP32 3.x API: attach + configure in one call
    ledcWrite(BUZZER_PIN, 128);              // 50% duty
    Serial.println("[BUZZER] Ring!");
}

void buzzerOff() {
    ledcWrite(BUZZER_PIN, 0);
    ledcDetach(BUZZER_PIN);
    pinMode(BUZZER_PIN, OUTPUT);  // re-assert GPIO output mode after LEDC detach
    digitalWrite(BUZZER_PIN, LOW);
    Serial.println("[BUZZER] Off");
}

// ==================== Fetch Welcome Audio URL from Backend ====================
String fetchWelcomeAudio() {
    // Return cached URL if already fetched
    if (welcomeAudioUrl.length() > 0) {
        return welcomeAudioUrl;
    }

    Serial.println("[WELCOME] Fetching welcome audio from backend...");
    WiFiClient client;
    if (!client.connect(SERVER_HOST, SERVER_PORT, 10000)) {
        Serial.println("[WELCOME] Connection failed");
        return "";
    }

    client.printf("GET /api/voice/welcome?machineId=%s HTTP/1.1\r\n", MACHINE_ID);
    client.printf("Host: %s:%d\r\n", SERVER_HOST, SERVER_PORT);
    client.println("Connection: close");
    client.println();

    // Wait for response (TTS generation can take several seconds)
    unsigned long timeout = millis() + 20000;

    // Wait for first byte
    while (!client.available() && client.connected() && millis() < timeout) {
        delay(10);
    }

    if (!client.available()) {
        Serial.println("[WELCOME] Timeout waiting for response");
        client.stop();
        return "";
    }

    // Read entire response
    String response = "";
    while (millis() < timeout) {
        if (client.available()) {
            response += (char)client.read();
        } else if (!client.connected()) {
            break;
        } else {
            delay(5);
        }
    }
    client.stop();

    Serial.printf("[WELCOME] Raw response length: %d\n", response.length());

    // Find JSON body after headers (\r\n\r\n)
    int bodyStart = response.indexOf("\r\n\r\n");
    if (bodyStart < 0) {
        bodyStart = response.indexOf("\n\n");
        if (bodyStart >= 0) bodyStart += 2;
    } else {
        bodyStart += 4;
    }

    if (bodyStart < 0 || bodyStart >= (int)response.length()) {
        Serial.println("[WELCOME] Could not find body in response");
        return "";
    }

    String body = response.substring(bodyStart);
    body.trim();
    Serial.printf("[WELCOME] Body: %s\n", body.c_str());

    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, body)) {
        Serial.println("[WELCOME] JSON parse error");
        return "";
    }

    const char *pcmUrl = doc["pcmUrl"] | "";
    const char *audioUrl = doc["audioUrl"] | "";

    // Prefer PCM (raw I2S playback) over MP3
    const char *bestUrl = (strlen(pcmUrl) > 0) ? pcmUrl : audioUrl;
    if (strlen(bestUrl) > 0) {
        welcomeAudioUrl = String("http://") + SERVER_HOST + ":" + SERVER_PORT + bestUrl;
        Serial.printf("[WELCOME] Cached: %s\n", welcomeAudioUrl.c_str());
        return welcomeAudioUrl;
    }
    return "";
}

// ==================== Doorbell Flow (AI Voice Assistant) ====================
void handleDoorbellFlow() {
    Serial.println("\n========== DOORBELL FLOW START ==========");
    Serial.printf("[VOICE] Free heap: %dKB\n", ESP.getFreeHeap() / 1024);

    // 1. Ring buzzer
    buzzerOn();
    delay(BUZZER_DURATION);
    buzzerOff();

    // 2. Notify backend via WebSocket
    sendDoorbellAlert();

    // 3. Play welcome greeting through speaker
    String welcomeUrl = fetchWelcomeAudio();
    if (welcomeUrl.length() > 0) {
        Serial.println("[VOICE] Playing welcome greeting...");
        playAudioFromURL(welcomeUrl.c_str());
    } else {
        Serial.println("[VOICE] No welcome audio, skipping greeting");
    }

    // 4. Check pre-allocated buffer
    if (!audioBuffer) {
        Serial.println("[VOICE] ERROR: Audio buffer not allocated!");
        return;
    }

    // Clear the buffer
    memset(audioBuffer, 0, audioBufferMaxSamples * sizeof(int16_t));

    // 4. Record visitor audio
    Serial.printf("[VOICE] Recording %ds at %dHz...\n", RECORD_SECONDS, AUDIO_SAMPLE_RATE);
    int samplesRecorded = recordAudio(audioBuffer, audioBufferMaxSamples, RECORD_SECONDS * 1000);
    Serial.printf("[VOICE] Recorded %d samples (%dKB)\n",
        samplesRecorded, samplesRecorded * 2 / 1024);

    // 5. Send raw audio to backend → backend does Groq Whisper STT + AI + TTS
    Serial.println("[VOICE] Sending audio to backend for STT+AI+TTS...");
    String audioUrl = sendAudioToBackend(audioBuffer, samplesRecorded);

    // 6. Play AI response through speaker
    if (audioUrl.length() > 0) {
        Serial.println("[VOICE] Playing AI response on speaker...");
        playAudioFromURL(audioUrl.c_str());
    } else {
        Serial.println("[VOICE] No audio response received from backend");
    }

    Serial.printf("[VOICE] Flow complete. Free heap: %dKB\n", ESP.getFreeHeap() / 1024);
    Serial.println("========== DOORBELL FLOW END ==========\n");
}

// ==================== Setup ====================
void setup() {
    Serial.begin(115200);
    Serial.println("\n=== Doorlance - ESP32 Voice Controller ===");

    // Disable JTAG on GPIO 13 to allow relay control
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << RELAY_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_ENABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);
    ESP_ERROR_CHECK(gpio_iomux_out(RELAY_PIN, 0, false)); // Remove JTAG overlay

    pinMode(RELAY_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(RELAY_PIN, LOW);
    doorLocked = true;
    Serial.println("[RELAY] GPIO 13 initialized and JTAG disabled");

    // Pre-allocate audio buffer EARLY before heap fragments
    audioBufferMaxSamples = AUDIO_SAMPLE_RATE * RECORD_SECONDS;
    audioBuffer = (int16_t *)malloc(audioBufferMaxSamples * sizeof(int16_t));
    if (audioBuffer) {
        Serial.printf("[MEM] Audio buffer allocated: %dKB (%d samples)\n",
            audioBufferMaxSamples * 2 / 1024, audioBufferMaxSamples);
    } else {
        Serial.printf("[MEM] FAILED to allocate audio buffer! Heap: %d\n", ESP.getFreeHeap());
    }

    setupMic();
    setupSpeaker();

    // Play test tone at boot to verify speaker hardware
    testSpeaker();

    connectWiFi();

    webSocket.begin(SERVER_HOST, SERVER_PORT, "/ws");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(WS_RECONNECT_TIME);

    Serial.printf("Setup complete. Free heap: %dKB\n", ESP.getFreeHeap() / 1024);
}

// ==================== Main Loop ====================
void loop() {
    webSocket.loop();

    // Play owner-initiated TTS audio here (NOT inside WS callback) so the
    // WebSocket library stays responsive during the blocking HTTP stream.
    if (pendingAudioPlay && !doorbellFlowActive) {
        pendingAudioPlay = false;
        Serial.println("[INTERCOM] Playing owner audio from main loop...");
        playAudioFromURL(pendingAudioUrl.c_str());
        pendingAudioUrl = "";
    }

    if (!doorbellFlowActive) {
        checkDoorbell();
    }

    if (autoRelockPending && millis() - doorUnlockTime >= DOOR_UNLOCK_TIME) {
        lockDoor();
        autoRelockPending = false;
    }

    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        sendHeartbeat();
        lastHeartbeat = millis();
    }
}

// ==================== WiFi ====================
void connectWiFi() {
    Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\nWiFi failed! Restarting...");
        ESP.restart();
    }
}

// ==================== WebSocket ====================
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS] Disconnected");
            break;
        case WStype_CONNECTED:
            Serial.printf("[WS] Connected: %s\n", payload);
            {
                StaticJsonDocument<256> doc;
                doc["type"] = "register";
                doc["device"] = "esp32_controller";
                doc["machineId"] = MACHINE_ID;
                doc["password"] = MACHINE_PASSWORD;
                String msg;
                serializeJson(doc, msg);
                webSocket.sendTXT(msg);
            }
            sendStatus();
            break;
        case WStype_TEXT:
            Serial.printf("[WS] Received: %s\n", payload);
            handleCommand((const char *)payload);
            break;
        default:
            break;
    }
}

// ==================== Command Handler ====================
void handleCommand(const char *payload) {
    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, payload)) return;

    const char *command = doc["command"];
    if (!command) return;

    if (strcmp(command, "unlock") == 0) {
        unlockDoor();
        bool autoRelock = doc["autoRelock"] | false;
        if (autoRelock) {
            autoRelockPending = true;
            doorUnlockTime = millis();
        }
        StaticJsonDocument<128> resp;
        resp["type"] = "command_response";
        resp["command"] = "unlock";
        resp["status"] = "success";
        String msg;
        serializeJson(resp, msg);
        webSocket.sendTXT(msg);

    } else if (strcmp(command, "lock") == 0) {
        lockDoor();
        autoRelockPending = false;
        StaticJsonDocument<128> resp;
        resp["type"] = "command_response";
        resp["command"] = "lock";
        resp["status"] = "success";
        String msg;
        serializeJson(resp, msg);
        webSocket.sendTXT(msg);

    } else if (strcmp(command, "status") == 0) {
        sendStatus();

    } else if (strcmp(command, "play_audio") == 0) {
        // Intercom: owner sends message → backend TTS → play on speaker
        // IMPORTANT: Do NOT call playAudioFromURL here — it blocks for several seconds
        // and stalls the WebSocket library, breaking the WS connection.
        // Instead, store the URL and let the main loop() play it.
        const char *url = doc["url"];
        if (url) {
            pendingAudioUrl = String("http://") + SERVER_HOST + ":" + SERVER_PORT + url;
            pendingAudioPlay = true;
            Serial.printf("[INTERCOM] Audio queued for playback: %s\n", pendingAudioUrl.c_str());
        }
    }
}

// ==================== Door Control ====================
void unlockDoor() {
    digitalWrite(RELAY_PIN, HIGH);
    doorLocked = false;
    Serial.println("[RELAY] Door UNLOCKED - Relay ON (HIGH)");
}

void lockDoor() {
    digitalWrite(RELAY_PIN, LOW);
    doorLocked = true;
    Serial.println("[RELAY] Door LOCKED - Relay OFF (LOW)");
}

// ==================== Status & Heartbeat ====================
void sendStatus() {
    StaticJsonDocument<256> doc;
    doc["type"] = "status";
    doc["device"] = "esp32_controller";
    doc["machineId"] = MACHINE_ID;
    doc["doorLocked"] = doorLocked;
    doc["wifiRSSI"] = WiFi.RSSI();
    doc["uptime"] = millis() / 1000;
    doc["ip"] = WiFi.localIP().toString();
    String msg;
    serializeJson(doc, msg);
    webSocket.sendTXT(msg);
}

void sendHeartbeat() {
    if (!webSocket.isConnected()) return;
    StaticJsonDocument<128> doc;
    doc["type"] = "heartbeat";
    doc["device"] = "esp32_controller";
    doc["machineId"] = MACHINE_ID;
    doc["doorLocked"] = doorLocked;
    String msg;
    serializeJson(doc, msg);
    webSocket.sendTXT(msg);
}

// ==================== Doorbell ====================
void checkDoorbell() {
    int buttonState = digitalRead(BUTTON_PIN);

    // Button just pressed (HIGH → LOW)
    if (buttonState == LOW && lastButtonState == HIGH) {
        buttonPressStart = millis();
        buttonHeld = true;
        Serial.println("[BELL] Button pressed...");
    }

    // Button is being held — check if we crossed the hold threshold
    if (buttonState == LOW && buttonHeld && !doorbellFlowActive) {
        unsigned long held = millis() - buttonPressStart;
        if (held >= HOLD_THRESHOLD) {
            // Crossed threshold while still held — start voice flow
            if (millis() - lastButtonPress < BUTTON_COOLDOWN) {
                Serial.println("[BELL] Cooldown active, ignoring hold");
                buttonHeld = false;
                lastButtonState = buttonState;
                return;
            }
            lastButtonPress = millis();
            Serial.printf("[BELL] Hold detected (%lums) — voice flow\n", held);
            doorbellFlowActive = true;

            // Buzzer + alert
            buzzerOn();
            delay(BUZZER_DURATION);
            buzzerOff();
            sendDoorbellAlert();

            // Record while button is still held
            if (audioBuffer) {
                memset(audioBuffer, 0, audioBufferMaxSamples * sizeof(int16_t));
                Serial.println("[BELL] Recording while held...");
                int samplesRecorded = recordAudioWhileHeld(audioBuffer, audioBufferMaxSamples);

                // Process: send raw audio to backend → backend does STT+AI+TTS → play
                if (samplesRecorded > 0) {
                    Serial.println("[VOICE] Sending audio to backend for STT+AI+TTS...");
                    String audioUrl = sendAudioToBackend(audioBuffer, samplesRecorded);

                    if (audioUrl.length() > 0) {
                        Serial.println("[VOICE] Playing AI response...");
                        playAudioFromURL(audioUrl.c_str());
                    }
                } else {
                    Serial.println("[BELL] No audio recorded (button released too quickly after threshold)");
                }
            }

            doorbellFlowActive = false;
            buttonHeld = false;
            Serial.println("========== VOICE FLOW END ==========\n");
        }
    }

    // Button released before threshold — short press
    if (buttonState == HIGH && lastButtonState == LOW && buttonHeld) {
        buttonHeld = false;
        unsigned long pressDuration = millis() - buttonPressStart;

        if (millis() - lastButtonPress < BUTTON_COOLDOWN) {
            Serial.println("[BELL] Cooldown active, ignoring");
            lastButtonState = buttonState;
            return;
        }
        lastButtonPress = millis();

        Serial.printf("[BELL] Short press (%lums) — buzzer only\n", pressDuration);
        doorbellFlowActive = true;
        buzzerOn();
        delay(BUZZER_DURATION);
        buzzerOff();
        sendDoorbellAlert();
        doorbellFlowActive = false;
    }

    lastButtonState = buttonState;
}

void sendDoorbellAlert() {
    if (!webSocket.isConnected()) return;
    StaticJsonDocument<256> doc;
    doc["type"] = "doorbell_pressed";
    doc["device"] = "esp32_controller";
    doc["machineId"] = MACHINE_ID;
    doc["timestamp"] = millis();
    String msg;
    serializeJson(doc, msg);
    webSocket.sendTXT(msg);
    Serial.println("[BELL] Alert sent to backend");
}
