const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TTS_DIR = path.join(__dirname, '..', 'uploads', 'tts');

// Ensure TTS directory exists
fs.mkdirSync(TTS_DIR, { recursive: true });

/**
 * Speech-to-Text using Groq Whisper API
 * @param {Buffer} wavBuffer - Complete WAV file buffer
 * @returns {string} Transcribed text
 */
async function speechToText(wavBuffer) {
    const fetch = (await import('node-fetch')).default;
    const form = new FormData();
    form.append('file', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
    });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            ...form.getHeaders(),
        },
        body: form,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq STT failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.text || '';
}

/**
 * Generate AI door assistant response using Groq LLM
 * @param {string} transcript - What the visitor said
 * @param {string} visitorType - 'family', 'stranger', or 'unknown'
 * @param {string} visitorName - Name if family member identified
 * @returns {string} AI response text
 */
async function generateDoorResponse(transcript, visitorType = 'unknown', visitorName = null) {
    const fetch = (await import('node-fetch')).default;

    let context = '';
    if (visitorType === 'family' && visitorName) {
        context = `The visitor has been identified as ${visitorName}, a family member. The door has been unlocked automatically.`;
    } else if (transcript && transcript.trim().length > 0) {
        context = `An unidentified visitor is at the door. They said: "${transcript}"`;
    } else {
        context = 'Someone pressed the doorbell but did not say anything.';
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content: `You are Doorlance, a smart AI door assistant. You speak through a speaker at the front door.
Your job is to greet visitors, ask them their purpose, and inform them that the homeowner has been notified.
Keep responses SHORT (1-2 sentences max). Be polite but concise. Speak naturally as if talking face to face.
Do NOT use emojis or special characters. Do NOT mention you are an AI.`,
                },
                {
                    role: 'user',
                    content: context,
                },
            ],
            max_tokens: 80,
            temperature: 0.7,
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq LLM failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'Hello, the homeowner has been notified.';
}

/**
 * Text-to-Speech using Google Translate TTS
 * Downloads MP3, saves locally, returns relative URL path
 * @param {string} text - Text to convert to speech
 * @returns {string} Relative URL path to the audio file
 */
async function textToSpeech(text) {
    const googleTTS = require('google-tts-api');
    const fetch = (await import('node-fetch')).default;

    const filename = `tts_${Date.now()}.mp3`;
    const filepath = path.join(TTS_DIR, filename);

    try {
        if (text.length <= 200) {
            const url = googleTTS.getAudioUrl(text, { lang: 'en', slow: false });
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            });
            if (!response.ok) throw new Error(`Google TTS HTTP ${response.status}`);
            const buffer = await response.buffer();
            fs.writeFileSync(filepath, buffer);
        } else {
            // Long text: split into multiple URLs
            const urls = googleTTS.getAllAudioUrls(text, { lang: 'en', slow: false });
            const buffers = [];
            for (const { url } of urls) {
                const resp = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    },
                });
                if (resp.ok) {
                    buffers.push(await resp.buffer());
                }
            }
            fs.writeFileSync(filepath, Buffer.concat(buffers));
        }

        console.log(`[TTS] Generated: ${filename} (${fs.statSync(filepath).size} bytes)`);
        return `/uploads/tts/${filename}`;
    } catch (err) {
        console.error('[TTS] Google TTS failed:', err.message);

        // Fallback: use system TTS (Windows SAPI)
        try {
            const wavFilename = `tts_${Date.now()}.wav`;
            const wavPath = path.join(TTS_DIR, wavFilename);
            const say = require('say');
            await new Promise((resolve, reject) => {
                say.export(text, null, 1.0, wavPath, (e) => e ? reject(e) : resolve());
            });
            console.log(`[TTS] Fallback generated: ${wavFilename}`);
            return `/uploads/tts/${wavFilename}`;
        } catch (fallbackErr) {
            console.error('[TTS] Fallback also failed:', fallbackErr.message);
            throw new Error('All TTS methods failed');
        }
    }
}

/**
 * Clean up old TTS files (older than 1 hour)
 */
function cleanupTTSFiles() {
    try {
        const files = fs.readdirSync(TTS_DIR);
        const oneHourAgo = Date.now() - 3600000;
        for (const file of files) {
            const filepath = path.join(TTS_DIR, file);
            const stat = fs.statSync(filepath);
            if (stat.mtimeMs < oneHourAgo) {
                fs.unlinkSync(filepath);
            }
        }
    } catch (err) {
        // Ignore cleanup errors
    }
}

// Run cleanup every 30 minutes
setInterval(cleanupTTSFiles, 1800000);

/**
 * Convert any audio file (MP3/WAV) to raw PCM: 16-bit signed LE, 16kHz, mono
 * Uses ffmpeg-static bundled binary
 * @param {string} inputPath - Path to input audio file
 * @returns {string} Path to output .pcm file
 */
function convertToPcm(inputPath) {
    const pcmPath = inputPath.replace(/\.(mp3|wav)$/i, '.pcm');
    try {
        execFileSync(ffmpegPath, [
            '-y',              // overwrite
            '-i', inputPath,   // input
            '-f', 's16le',     // raw signed 16-bit little-endian
            '-acodec', 'pcm_s16le',
            '-ar', '16000',    // 16kHz sample rate
            '-ac', '1',        // mono
            pcmPath
        ], { timeout: 10000 });
        const stat = fs.statSync(pcmPath);
        console.log(`[TTS] PCM converted: ${path.basename(pcmPath)} (${stat.size} bytes, ${(stat.size / 32000).toFixed(1)}s)`);
        return pcmPath;
    } catch (err) {
        console.error('[TTS] FFmpeg conversion failed:', err.message);
        return null;
    }
}

module.exports = { speechToText, generateDoorResponse, textToSpeech, convertToPcm };
