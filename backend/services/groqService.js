const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Detect if there is a human in the image using Groq Vision LLM
 * @param {string} base64Image - Base64 encoded image
 * @returns {object} { isHuman: boolean, confidence: string, description: string }
 */
async function detectHuman(base64Image) {
    try {
        const response = await groq.chat.completions.create({
            model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Analyze this image from a door security camera. Determine:
1. Is there a human person visible in this image? (yes/no)
2. How confident are you? (high/medium/low)
3. Brief description of what you see (1-2 sentences)

Respond ONLY in this exact JSON format, no other text:
{"isHuman": true/false, "confidence": "high/medium/low", "description": "brief description"}`
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            temperature: 0.1,
            max_tokens: 200,
        });

        const content = response.choices[0]?.message?.content || '';
        console.log('[Groq] Human detection response:', content);

        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return { isHuman: false, confidence: 'low', description: 'Could not analyze image' };
    } catch (err) {
        console.error('[Groq] Human detection error:', err);
        throw err;
    }
}

/**
 * Compare a captured face against family member images
 * @param {string} capturedBase64 - Base64 of captured image
 * @param {Array} familyMembers - Array of { name, imageBase64 }
 * @returns {object} { isMatch: boolean, matchedName: string|null, confidence: string }
 */
async function matchFace(capturedBase64, familyMembers) {
    if (!familyMembers || familyMembers.length === 0) {
        return { isMatch: false, matchedName: null, confidence: 'none' };
    }

    try {
        // Build the content array with all images
        const content = [
            {
                type: 'text',
                text: `You are a door security face recognition system. I will show you:
- Image 1: A live capture from a door camera (the person trying to enter)
- Images 2+: Reference photos of registered family members who are authorized to enter

Your task: Does the person in Image 1 match ANY of the reference family members?

Family members registered: ${familyMembers.map((m, i) => `Image ${i + 2} = "${m.name}"`).join(', ')}

IMPORTANT RULES:
- Different lighting, angles, or image quality should NOT disqualify a match
- Focus on facial features: face shape, eyes, nose, mouth, overall appearance
- If the person in Image 1 COULD be the same person as any reference photo, set isMatch to true
- Only set isMatch to false if you are confident it is a DIFFERENT person or no face is visible

Respond ONLY in this exact JSON format (no other text):
{"isMatch": true/false, "matchedName": "exact name from list or null", "confidence": "high/medium/low", "reasoning": "one sentence"}`
            },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${capturedBase64}`
                }
            }
        ];

        // Add family member images (limit to 4 for API constraints)
        const membersToCheck = familyMembers.slice(0, 4);
        for (const member of membersToCheck) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${member.imageBase64}`
                }
            });
        }

        const response = await groq.chat.completions.create({
            model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [{ role: 'user', content }],
            temperature: 0.1,
            max_tokens: 300,
        });

        const responseContent = response.choices[0]?.message?.content || '';
        console.log('[Groq] Face match response:', responseContent);

        const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return { isMatch: false, matchedName: null, confidence: 'low' };
    } catch (err) {
        console.error('[Groq] Face matching error:', err);
        throw err;
    }
}

module.exports = { detectHuman, matchFace };
