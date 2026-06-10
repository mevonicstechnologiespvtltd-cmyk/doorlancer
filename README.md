# Smart Door Lock System

A complete IoT smart door lock system using ESP32, ESP-CAM, Node.js backend with Firebase, Groq AI for human detection, and a React Native mobile app.

## Run everything with one command

From this folder (`smart door/`):

```powershell
npm install         # one-time only (also installs backend + app deps if not done yet)
npm start           # starts backend (port 3000) AND Expo app together
```

Other handy scripts:

| Script | What it does |
|---|---|
| `npm start` | Backend + Expo (production-ish) |
| `npm run dev` | Backend with `nodemon` (auto-restart) + Expo |
| `npm run start:web` | Backend + Expo Web (`localhost:19006`) |
| `npm run start:backend` | Backend only |
| `npm run start:app` | Expo only |
| `npm run install:all` | Install deps in root + backend + mobile-app |

Press `Ctrl+C` once to stop both.



## Architecture

```
┌─────────────┐     WiFi/HTTP      ┌──────────────────┐     API/WS      ┌──────────────┐
│  ESP32-CAM   │ ──────────────────►│  Node.js Backend │◄───────────────►│  Mobile App  │
│  (Camera +   │   Motion + Image   │  + Firebase      │  Real-time      │  (React      │
│   PIR Sensor)│                    │  + Groq AI       │  Commands       │   Native)    │
└─────────────┘                    └────────┬─────────┘                 └──────────────┘
                                            │ WebSocket
┌─────────────┐                             │
│  ESP32 Main  │◄───────────────────────────┘
│  Controller  │     Lock/Unlock Commands
│  (Relay +    │
│   Solenoid)  │
└─────────────┘
```

## Features

- **Motion Detection**: PIR sensor triggers camera capture
- **AI Human Detection**: Groq LLM Vision analyzes images for human presence
- **Family Face Recognition**: Auto-unlock door for recognized family members
- **Push Notifications**: Alert when someone is at the door
- **Remote Door Control**: Lock/unlock from mobile app
- **Live Camera View**: See who's at the door in real-time
- **Activity Logs**: Track all door events

## Hardware Requirements

| Component | Purpose |
|-----------|---------|
| ESP32 DevKit V1 | Main controller |
| AI Thinker ESP32-CAM | Camera module |
| 5V Relay Module | Solenoid control |
| Solenoid Lock (12V) | Door locking mechanism |
| PIR Motion Sensor (HC-SR501) | Motion detection |
| 12V Power Supply | Solenoid power |
| Breadboard + Jumper Wires | Connections |

## Wiring Diagram

### ESP32 Main Controller
```
ESP32 GPIO 26 ──► Relay IN
ESP32 GPIO 27 ──► Status LED (+)
ESP32 GPIO 25 ──► Buzzer (+)
ESP32 GND     ──► Relay GND / LED(-) / Buzzer(-)
ESP32 VIN     ──► Relay VCC (5V)
Relay COM     ──► 12V Supply (+)
Relay NO      ──► Solenoid (+)
Solenoid (-)  ──► 12V Supply (-)
```

### ESP32-CAM
```
ESP-CAM GPIO 13 ──► PIR Sensor OUT
ESP-CAM 5V      ──► PIR VCC
ESP-CAM GND     ──► PIR GND
```

## Project Structure

```
smart door/
├── backend/                    # Node.js Backend Server
│   ├── .env                    # Environment variables (credentials)
│   ├── server.js               # Main server entry point
│   ├── config/
│   │   └── firebase.js         # Firebase Admin SDK setup
│   ├── middleware/
│   │   └── auth.js             # JWT authentication middleware
│   ├── routes/
│   │   ├── auth.js             # User & machine authentication
│   │   ├── door.js             # Door lock/unlock control
│   │   ├── camera.js           # Camera capture & motion handling
│   │   ├── family.js           # Family member management
│   │   └── notification.js     # Notification management
│   └── services/
│       ├── groqService.js      # Groq AI human/face detection
│       ├── notificationService.js  # Push notifications
│       └── websocketService.js # Real-time WebSocket handling
│
├── mobile-app/                 # React Native (Expo) Mobile App
│   ├── App.js                  # App entry point
│   ├── app.json                # Expo configuration
│   └── src/
│       ├── screens/
│       │   ├── LoginScreen.js
│       │   ├── RegisterScreen.js
│       │   ├── AddMachineScreen.js
│       │   ├── DashboardScreen.js
│       │   ├── CameraViewScreen.js
│       │   ├── FamilyScreen.js
│       │   └── NotificationScreen.js
│       └── services/
│           ├── api.js              # Backend API client
│           └── notificationService.js  # Push notification setup
│
PlatformIO Projects/smart door/    # ESP32 Firmware (PlatformIO)
├── platformio.ini              # PlatformIO config (2 environments)
├── include/
│   └── config.h                # WiFi, server, pin configuration
└── src/
    ├── main.cpp                # ESP32 main controller firmware
    └── espcam_main.cpp         # ESP-CAM firmware
```

## Setup Instructions

### 1. Firebase Setup

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project
3. Enable **Firestore Database** (start in test mode)
4. Enable **Firebase Storage**
5. Enable **Cloud Messaging** (for push notifications)
6. Go to Project Settings > Service Accounts > Generate New Private Key
7. Copy the values into `backend/.env`

### 2. Groq API Setup

1. Go to [Groq Console](https://console.groq.com)
2. Create an API key
3. Add to `backend/.env` as `GROQ_API_KEY`

### 3. Backend Setup

```bash
cd "smart door/backend"
npm install
# Edit .env with your credentials
node server.js
```

The server will start on port 3000 with WebSocket support.

### 4. ESP32 Firmware Setup

1. Open the PlatformIO project in VS Code
2. Edit `include/config.h`:
   - Set your WiFi SSID and password
   - Set your backend server IP address
   - Set a machine ID and password (same as what you'll use in the app)

3. Flash the ESP32 main controller:
```bash
pio run -e esp32dev -t upload
```

4. Flash the ESP-CAM:
```bash
pio run -e esp32cam -t upload
```

### 5. Mobile App Setup

```bash
cd "smart door/mobile-app"
npm install

# Edit src/services/api.js - Update API_BASE_URL and WS_URL with your server IP

npx expo start
```

Scan the QR code with Expo Go app on your phone.

### 6. First Time Usage

1. Open the mobile app and **Register** a new account
2. **Add Machine** using the Machine ID and Password from `config.h`
3. The ESP32 and ESP-CAM will automatically connect to the backend
4. Add **Family Members** with photos for auto-unlock
5. When someone approaches the door:
   - PIR sensor triggers → ESP-CAM captures image
   - Backend uses Groq AI to detect human
   - If human detected → checks against family photos
   - If family member → door auto-unlocks
   - If unknown person → push notification sent to your phone
   - You can view camera and unlock remotely from the app

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | User login |
| POST | `/api/auth/add-machine` | Register new machine |
| POST | `/api/auth/login-machine` | Connect to existing machine |
| POST | `/api/door/unlock` | Unlock door |
| POST | `/api/door/lock` | Lock door |
| GET | `/api/door/status/:machineId` | Get door status |
| GET | `/api/door/logs/:machineId` | Get activity logs |
| GET | `/api/camera/capture/:machineId` | Capture image on demand |
| GET | `/api/camera/stream-url/:machineId` | Get stream URL |
| POST | `/api/camera/motion-detected` | ESP-CAM motion alert |
| POST | `/api/family/add` | Add family member |
| GET | `/api/family/list` | List family members |
| DELETE | `/api/family/remove/:id` | Remove family member |
| GET | `/api/notification/list` | Get notifications |
| PUT | `/api/notification/mark-read/:id` | Mark as read |

## Environment Variables

All sensitive credentials are stored in `.env` files:

- `backend/.env` - Firebase, Groq API, JWT secret
- `mobile-app/.env` - Backend server URL
- `include/config.h` - WiFi credentials, server IP, machine credentials

**Never commit `.env` files to version control.**

## Tech Stack

- **ESP32/ESP-CAM**: Arduino framework (PlatformIO)
- **Backend**: Node.js, Express, WebSocket (ws)
- **Database**: Firebase Firestore
- **Storage**: Firebase Cloud Storage
- **Auth**: JWT + bcrypt
- **AI**: Groq LLM Vision API (Llama 3.2 90B Vision)
- **Notifications**: Firebase Cloud Messaging
- **Mobile App**: React Native (Expo)
