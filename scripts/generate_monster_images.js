
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { removeBackground } from './utils/background_remover.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONSTERS_PATH = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images/monsters');

// Ensure directory exists
if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// CONFIGURATION
const USE_LOCAL_SD = true; // Set to true to use local Stable Diffusion
const LOCAL_SD_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';
const USE_LLM_PROMPTER = true; // Set to true to use Local LLM (Ollama) for prompts
const LOCAL_LLM_URL = 'http://127.0.0.1:11434/api/generate';

async function generatePromptWithLLM(monster, cleanName) {
    const descriptionContext = monster.description && monster.description.length > 10 ? `\n\nMonster Description Data:\n"${monster.description.substring(0, 1000)}..."` : "";
    
    const systemPrompt = `You are a prompt engineer for a Dungeons & Dragons monster image generation AI.
    Monster Name: "${cleanName}"
    Type: "${monster.type || 'Unknown'}"
    ${descriptionContext}
    
    Task: Generate a single prompt string following this EXACT template:
    "(isolated on flat pure white background:1.6), (no shadow:1.4), (full body shot:1.5), (perspective view:1.3), a high-quality digital 3D render of [INSERT VISUAL DESCRIPTION OF MONSTER], centered, magical fantasy style, dramatic lighting, sharp focus, intricate detail, 8k, Unreal Engine 5 render, masterpiece"
    
    Rules:
    1. Replace [INSERT VISUAL DESCRIPTION...] with a detailed physical description of the creature.
       - **USE YOUR KNOWLEDGE:** Combine the provided description with your own extensive knowledge of D&D lore and monster visuals. If the provided description is sparse, rely on the Monster Name to fill in the missing details from your training data.
       - **Ignore game statistics** (STR, DEX, HP, AC, etc.) in the description data. Focus ONLY on lore and visual appearance.
       - Describe: body shape, skin/fur/scales texture, limbs, head/face, distinctive features (wings, horns, tails), and colors.
       - **CRITICAL:** Ensure the description implies a WHOLE creature (e.g., 'full body dragon', 'entire giant spider').
       - **Style:** Medieval Fantasy / D&D.
    2. Make it **EYE-CATCHING**: Include menacing poses, magical auras, or action elements if appropriate.
    3. Do NOT describe: text, ui, stats, health bars, grid lines, multiple views, or background scenery (other than white).
    4. Output ONLY the prompt string.`;
        
        const payload = JSON.stringify({
        model: "llama3", // or "mistral", check your ollama models
        prompt: systemPrompt,
        stream: false
    });

    try {
        const res = await fetch(LOCAL_LLM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
        });
        const json = await res.json();
        if (!json.response) {
            console.warn("LLM Unexpected Response:", JSON.stringify(json));
            return null;
        }
        let cleanResponse = json.response.trim();
        // Extract content between first and last quotes if present
        const quoteMatch = cleanResponse.match(/"([^"]+)"/);
        if (quoteMatch && quoteMatch[1].length > 20) {
            cleanResponse = quoteMatch[1];
        } else {
            // Fallback cleaning if no quotes found
            cleanResponse = cleanResponse.replace(/^(Here is|Here's|The) (the )?(generated )?prompt( string)?(:)?\s*/i, '');
            cleanResponse = cleanResponse.replace(/^"(.*)"$/, '$1');
        }
        return cleanResponse;
    } catch (e) {
        console.warn(`LLM Generation failed: ${e.message}`, e.cause ? e.cause : "");
        return null;
    }
}

async function generateLocalSD(prompt, negative_prompt, filepath) {
    return new Promise((resolve, reject) => {
        // Enforce strong negative prompts to prevent artifacts
        // Note: Removed 'person', 'man', 'woman', 'face', 'hands', 'body' as monsters can be humanoid.
        const baseNegative = "text, watermark, signature, blur, blurry, low quality, bad anatomy, deformed, collage, frame, border, (icon:1.2), (ui:1.2), (symbol:1.2), grid, graph, chart, stats, numbers, interface, hud, health bar, multiple views, split screen, modern, sci-fi, futuristic, cyber, car, vehicle, photograph, photorealistic, camera, landscape, scenery, room, interior, exterior, house, building, architecture";
        
        const finalNegative = negative_prompt ? `${baseNegative}, ${negative_prompt}` : baseNegative;

        const payload = JSON.stringify({
            prompt: prompt,
            negative_prompt: finalNegative,
            steps: 25,
            width: 512,
            height: 512,
            cfg_scale: 7,
            sampler_name: "Euler a"
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
            },
            timeout: 300000 // 5 minutes timeout
        };

        const req = http.request(LOCAL_SD_URL, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Local SD API Error: ${res.statusCode}`));
                    return;
                }
                try {
                    const json = JSON.parse(data);
                    if (json.images && json.images.length > 0) {
                        const buffer = Buffer.from(json.images[0], 'base64');
                        // Save original image without background removal
                        fs.writeFileSync(filepath, buffer);
                        resolve();
                        /*
                        // Background removal disabled due to artifacts on complex backgrounds
                        removeBackground(buffer).then(pngBuffer => {
                            fs.writeFileSync(filepath, pngBuffer);
                            resolve();
                        }).catch(err => {
                             console.warn("Background removal failed, saving original:", err);
                             fs.writeFileSync(filepath, buffer);
                             resolve();
                        });
                        */
                    } else {
                        reject(new Error("No images returned from Local SD"));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error("Local SD Timeout"));
        });

        req.write(payload);
        req.end();
    });
}

function toTitleCase(str) {
    return str.replace(
        /\w\S*/g,
        function(txt) {
            return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
        }
    );
}

async function generateMonsterImages() {
    console.log("Reading monsters.json...");
    const rawData = fs.readFileSync(MONSTERS_PATH, 'utf-8');
    const monsters = JSON.parse(rawData);
    
    console.log(`Found ${monsters.length} monsters. Starting generation...`);
    if (USE_LOCAL_SD) {
        console.log(`Using Local Stable Diffusion at ${LOCAL_SD_URL}`);
    }
    
    let updatedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < monsters.length; i++) {
        const monster = monsters[i];
        
        // Skip if already has an image
        // Check if image field exists AND is not empty AND does not look like a placeholder if we have those
        if (monster.image && monster.image.trim() !== "") {
            // Optional: Check if file actually exists on disk? 
            // For now, trust the JSON.
            // skippedCount++;
            // continue; 
            
            // Actually, let's verify if it's a generated image we made, or an existing PDF extraction
            // If it points to images/monsters/... we might want to check existence.
            // If it points to images/Creature_Codex/... it's likely from PDF.
            
            // Let's just check if file exists. If not, regenerate.
            const existingPath = path.join(__dirname, '../public', monster.image);
            if (fs.existsSync(existingPath)) {
                continue;
            } else {
                console.log(`Image missing for ${monster.name} at ${monster.image}, regenerating...`);
            }
        }

        let cleanName = toTitleCase(monster.name).trim();
        const safeName = cleanName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const filename = `${safeName}.png`;
        const localPath = `images/monsters/${filename}`;
        const fullPath = path.join(IMAGES_DIR, filename);

        // Check if we already generated it but JSON wasn't updated (or running again)
        if (fs.existsSync(fullPath)) {
            if (monster.image !== localPath) {
                monster.image = localPath;
                updatedCount++;
            }
            continue;
        }

        console.log(`Generating image for [${i + 1}/${monsters.length}]: ${cleanName}...`);

        let success = false;
        let retries = 0;
        const maxRetries = 3;

        while (!success && retries < maxRetries) {
            try {
                let prompt = "";
                
                // 1. Use LLM
                if (USE_LLM_PROMPTER) {
                    const llmPrompt = await generatePromptWithLLM(monster, cleanName);
                    if (llmPrompt) prompt = llmPrompt;
                }

                // 2. Fallback (Basic)
                if (!prompt) {
                    prompt = `(isolated on flat pure white background:1.6), (no shadow:1.4), (full body shot:1.5), (perspective view:1.3), a high-quality digital 3D render of ${cleanName}, ${monster.type || 'creature'}, centered, magical fantasy style, dramatic lighting, sharp focus, intricate detail, 8k, Unreal Engine 5 render, masterpiece`;
                }

                console.log(`  -> Prompt: ${prompt.substring(0, 100)}...`);

                const negative_prompt = "shadow, cast shadow, contact shadow, floor, ground, horizon, texture, vignette, dark corners, noise, grain, gradient"; // Handled in generateLocalSD

                await generateLocalSD(prompt, negative_prompt, fullPath);
                
                // Success
                monster.image = localPath;
                updatedCount++;
                console.log(`  -> Saved to ${localPath}`);
                success = true;

            } catch (err) {
                console.error(`  -> Failed to generate for ${monster.name}: ${err.message}`);
                retries++;
                if (retries < maxRetries) await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        // Save progress every 5 monsters
        if (updatedCount > 0 && updatedCount % 5 === 0) {
             fs.writeFileSync(MONSTERS_PATH, JSON.stringify(monsters, null, 2));
        }
    }

    // Final Save
    fs.writeFileSync(MONSTERS_PATH, JSON.stringify(monsters, null, 2));
    console.log(`\nDone! Updated ${updatedCount} monsters.`);
}

generateMonsterImages().catch(console.error);
