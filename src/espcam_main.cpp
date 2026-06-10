/*
 * Smart Door Lock System - ESP-CAM Module (Standalone)
 * Only needs power (5V + GND). No physical wiring to ESP32 or sensors.
 * Connects to the same WiFi and registers with the backend server.
 * Provides MJPEG stream and single capture endpoints.
 * Backend fetches images from this camera when ESP32 reports motion.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "config.h"

// ==================== AI Thinker ESP32-CAM Pin Definitions ====================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// Global variables
httpd_handle_t stream_httpd = NULL;
httpd_handle_t camera_httpd = NULL;
String serverBaseUrl;
unsigned long lastRegisterTime = 0;
const unsigned long REGISTER_INTERVAL = 60000; // Re-register every 60s

// Active face scan every 8 seconds (only when motion is likely)
unsigned long lastFaceScan = 0;
const unsigned long FACE_SCAN_INTERVAL = 8000;
bool faceScanEnabled = true;

// Function declarations
void connectWiFi();
void initCamera();
void startCameraServer();
void registerWithBackend();
void sendImageForFaceCheck();

// MJPEG stream handler
#define PART_BOUNDARY "123456789000000000000987654321"
static const char *_STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *_STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char *_STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
    camera_fb_t *fb = NULL;
    esp_err_t res = ESP_OK;
    char part_buf[64];

    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "X-Framerate", "15");
    res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
    if (res != ESP_OK) return res;

    while (true) {
        fb = esp_camera_fb_get();
        if (!fb) {
            Serial.println("Camera capture failed");
            res = ESP_FAIL;
            break;
        }

        size_t hlen = snprintf(part_buf, 64, _STREAM_PART, fb->len);
        res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(req, part_buf, hlen);
        }
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
        }

        esp_camera_fb_return(fb);
        if (res != ESP_OK) break;
    }
    return res;
}

// Single capture handler
static esp_err_t capture_handler(httpd_req_t *req) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return res;
}

// Status handler
static esp_err_t status_handler(httpd_req_t *req) {
    StaticJsonDocument<256> doc;
    doc["device"] = "espcam";
    doc["machineId"] = MACHINE_ID;
    doc["status"] = "online";
    doc["ip"] = WiFi.localIP().toString();
    doc["rssi"] = WiFi.RSSI();
    doc["uptime"] = millis() / 1000;

    String response;
    serializeJson(doc, response);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, response.c_str(), response.length());
}

void setup() {
    Serial.begin(115200);
    Serial.println("\n=== Smart Door Lock - ESP-CAM Module (Standalone) ===");
    Serial.println("No physical connections needed - WiFi only");

    // Initialize camera
    initCamera();

    // Connect to WiFi
    connectWiFi();

    // Build server URL
    serverBaseUrl = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT);

    // Start camera HTTP server (for streaming and capture)
    startCameraServer();

    // Register with backend
    registerWithBackend();

    Serial.println("Setup complete. Camera ready and serving.");
}

void loop() {
    // Periodically re-register with backend to keep status online
    if (millis() - lastRegisterTime >= REGISTER_INTERVAL) {
        registerWithBackend();
        lastRegisterTime = millis();
    }

    // Active face scan: capture and send image to backend for recognition
    if (faceScanEnabled && millis() - lastFaceScan >= FACE_SCAN_INTERVAL) {
        sendImageForFaceCheck();
        lastFaceScan = millis();
    }

    // Reconnect WiFi if dropped
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi lost, reconnecting...");
        connectWiFi();
        registerWithBackend();
    }

    delay(100);
}

void initCamera() {
    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer = LEDC_TIMER_0;
    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk = XCLK_GPIO_NUM;
    config.pin_pclk = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.grab_mode = CAMERA_GRAB_LATEST;

    if (psramFound()) {
        config.frame_size = FRAMESIZE_QVGA;   // 320x240 for smooth streaming
        config.jpeg_quality = 10;              // Lower = better quality (1-63)
        config.fb_count = 4;                   // More buffers = smoother stream
        config.fb_location = CAMERA_FB_IN_PSRAM;
        config.grab_mode = CAMERA_GRAB_LATEST; // Always get latest frame
        Serial.println("PSRAM found - using QVGA for smooth streaming");
    } else {
        config.frame_size = FRAMESIZE_QVGA;
        config.jpeg_quality = 15;
        config.fb_count = 1;
        config.fb_location = CAMERA_FB_IN_DRAM;
        Serial.println("No PSRAM - using QVGA resolution");
    }

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        Serial.printf("Camera init failed with error 0x%x\n", err);
        ESP.restart();
    }

    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_brightness(s, 1);
        s->set_contrast(s, 1);
        s->set_saturation(s, 0);
        s->set_whitebal(s, 1);
        s->set_awb_gain(s, 1);
        s->set_wb_mode(s, 0);
        s->set_exposure_ctrl(s, 1);
        s->set_aec2(s, 1);
        s->set_gain_ctrl(s, 1);
    }

    Serial.println("Camera initialized successfully");
}

void connectWiFi() {
    Serial.print("Connecting to WiFi: ");
    Serial.println(WIFI_SSID);

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected!");
        Serial.print("ESP-CAM IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi connection failed! Restarting...");
        ESP.restart();
    }
}

void startCameraServer() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.ctrl_port = 32768;

    if (httpd_start(&camera_httpd, &config) == ESP_OK) {
        httpd_uri_t capture_uri = {
            .uri = "/capture",
            .method = HTTP_GET,
            .handler = capture_handler,
            .user_ctx = NULL
        };
        httpd_register_uri_handler(camera_httpd, &capture_uri);

        httpd_uri_t status_uri = {
            .uri = "/status",
            .method = HTTP_GET,
            .handler = status_handler,
            .user_ctx = NULL
        };
        httpd_register_uri_handler(camera_httpd, &status_uri);

        Serial.println("Camera server started on port 80");
    }

    config.server_port = 81;
    config.ctrl_port = 32769;
    if (httpd_start(&stream_httpd, &config) == ESP_OK) {
        httpd_uri_t stream_uri = {
            .uri = "/stream",
            .method = HTTP_GET,
            .handler = stream_handler,
            .user_ctx = NULL
        };
        httpd_register_uri_handler(stream_httpd, &stream_uri);

        Serial.println("Stream server started on port 81");
    }

    Serial.printf("Capture URL: http://%s/capture\n", WiFi.localIP().toString().c_str());
    Serial.printf("Stream URL:  http://%s:81/stream\n", WiFi.localIP().toString().c_str());
}

void registerWithBackend() {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    String url = serverBaseUrl + "/api/camera/register";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<256> doc;
    doc["machineId"] = MACHINE_ID;
    doc["password"] = MACHINE_PASSWORD;
    doc["device"] = "espcam";
    doc["ip"] = WiFi.localIP().toString();
    doc["captureUrl"] = String("http://") + WiFi.localIP().toString() + "/capture";
    doc["streamUrl"] = String("http://") + WiFi.localIP().toString() + ":81/stream";

    String body;
    serializeJson(doc, body);

    int httpCode = http.POST(body);
    if (httpCode == 200) {
        Serial.println("Registered with backend successfully");
    } else {
        Serial.printf("Backend registration failed: %d\n", httpCode);
    }
    http.end();
    lastRegisterTime = millis();
}

/**
 * Capture a JPEG from the camera and POST it to the backend for face recognition.
 * If the backend detects a known family member it will auto-unlock the door.
 */
void sendImageForFaceCheck() {
    if (WiFi.status() != WL_CONNECTED) return;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        Serial.println("[FaceScan] Camera capture failed");
        return;
    }

    HTTPClient http;
    String url = serverBaseUrl + "/api/camera/motion-detected";
    http.begin(url);
    http.setTimeout(15000);

    // Build multipart/form-data body manually
    String boundary = "ESP32FACE_BOUNDARY";
    http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);

    // Part 1: machineId field
    String head = "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"machineId\"\r\n\r\n";
    head += String(MACHINE_ID) + "\r\n";
    // Part 2: image file
    head += "--" + boundary + "\r\n";
    head += "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n";
    head += "Content-Type: image/jpeg\r\n\r\n";
    String tail = "\r\n--" + boundary + "--\r\n";

    size_t totalLen = head.length() + fb->len + tail.length();

    // Allocate buffer (prefer PSRAM if available)
    uint8_t *buf = (uint8_t*)(psramFound() ? ps_malloc(totalLen) : malloc(totalLen));
    if (!buf) {
        Serial.println("[FaceScan] Memory allocation failed");
        esp_camera_fb_return(fb);
        http.end();
        return;
    }

    memcpy(buf, head.c_str(), head.length());
    memcpy(buf + head.length(), fb->buf, fb->len);
    memcpy(buf + head.length() + fb->len, tail.c_str(), tail.length());
    esp_camera_fb_return(fb);

    int httpCode = http.POST(buf, totalLen);
    free(buf);
    http.end();

    if (httpCode == 200) {
        Serial.println("[FaceScan] Image processed by backend");
    } else if (httpCode > 0) {
        Serial.printf("[FaceScan] Backend response: %d\n", httpCode);
    } else {
        Serial.printf("[FaceScan] Request failed: %s\n", HTTPClient::errorToString(httpCode).c_str());
    }
}
