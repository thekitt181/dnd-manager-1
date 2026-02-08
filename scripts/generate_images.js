
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ITEMS_PATH = path.join(__dirname, '../src/items.json');
const IMAGES_DIR = path.join(__dirname, '../public/images/items');

// Ensure directory exists
if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36"
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function downloadImage(url, filepath, attempt = 1) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        
        const options = {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 60000 // 60 seconds timeout
        };

        const request = https.get(url, options, (response) => {
            if (response.statusCode === 429) {
                file.close();
                fs.unlink(filepath, () => {});
                // Rate limit hit - reject specifically for this
                reject(new Error("RATE_LIMIT"));
                return;
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(filepath, () => {}); // Delete partial
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            file.close();
            fs.unlink(filepath, () => {});
            reject(err);
        });

        request.on('timeout', () => {
            request.destroy();
            file.close();
            fs.unlink(filepath, () => {});
            reject(new Error("Timeout"));
        });
    });
}

import http from 'http';

// CONFIGURATION
const USE_LOCAL_SD = true; // Set to true to use local Stable Diffusion
const LOCAL_SD_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';
const USE_LLM_PROMPTER = true; // Set to true to use Local LLM (Ollama) for prompts
const LOCAL_LLM_URL = 'http://127.0.0.1:11434/api/generate';

async function generatePromptWithLLM(item, cleanName) {
    const descriptionContext = item.description && item.description.length > 10 ? `\n\nItem Description:\n"${item.description}"` : "";
    
    const systemPrompt = `You are a prompt engineer for a Dungeons & Dragons image generation AI.
    Item: "${cleanName}" (${item.type})
    ${descriptionContext ? `Context Description: "${item.description}"` : ""}
    
    Task: Generate a single prompt string following this EXACT template:
    "(isolated on white background:1.5), (simple background:1.3), (full shot:1.5), (perspective view:1.3), a high-quality digital 3D render of [INSERT VISUAL DESCRIPTION OF ITEM HERE], centered, magical fantasy style, vibrant colors, cinematic lighting, sharp focus, intricate detail, 8k, Unreal Engine 5 render, Octane render, masterpiece"
    
    Rules:
    1. Replace [INSERT VISUAL DESCRIPTION...] with a detailed description of the item's shape and materials.
       - **CRITICAL: This is a MEDIEVAL FANTASY world.**
       - **Ensure the description implies a COMPLETE object (e.g., 'full length staff', 'entire crossbow').**
       - **NEVER use modern terms** like: rifle, sniper, scope, tactical, polymer, plastic, gun, firearm, sci-fi, tech.
       - **NEVER describe architecture** like: house, building, tower, wall, room, door, window, furniture.
       - If it is a CROSSBOW: You MUST start description with "a medieval heavy crossbow weapon" and describe "wooden stock, steel prod (bow part), mechanical latch, bolt loaded". DO NOT describe it as a symbol, medal, shield, or building.
       - If it is a STAFF/ROD: Describe it as "a long magical staff, wooden or metal shaft, glowing crystal at tip, swirling magical energy".
    2. Make it **EYE-CATCHING**: Include glowing effects, intricate carvings, or magical auras.
    3. Do NOT describe people, characters, hands, or background surroundings (other than white).
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
        // Enforce strong negative prompts to prevent modern/human artifacts
        let baseNegative = "gun, rifle, pistol, revolver, firearm, sniper, modern, sci-fi, futuristic, cyber, tactical, plastic, polymer, photograph, photorealistic, camera, scope, trigger guard, clip, magazine, ammo, bullets, person, man, woman, face, hands, holding, multiple, collection, grid, text, watermark, signature, blur, blurry, low quality, bad anatomy, deformed, collage, frame, border, (icon:1.2), (ui:1.2), (symbol:1.2), architecture, building, house, home, tower, wall, room, interior, exterior, door, window, furniture, chair, table, lantern, lamp, landscape, scenery";
        
        // Dynamic Negative Prompts based on positive prompt content
        if (prompt.toLowerCase().includes("crossbow")) {
            baseNegative += ", circle, round, shield, crest, emblem, medallion, coin, disc, mandala, square, box, cube, rectangular";
        }

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
            timeout: 300000 // 5 minutes timeout for local generation
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
                        fs.writeFileSync(filepath, buffer);
                        resolve();
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

async function generateImages() {
    console.log("Reading items.json...");
    const rawData = fs.readFileSync(ITEMS_PATH, 'utf-8');
    const items = JSON.parse(rawData);
    
    console.log(`Found ${items.length} items. Starting generation...`);
    if (USE_LOCAL_SD) {
        console.log(`Using Local Stable Diffusion at ${LOCAL_SD_URL}`);
        console.log("Ensure you launched Automatic1111 with '--api' flag!");
    } else {
        console.log("Using Pollinations.ai (Remote)");
    }
    
    let updatedCount = 0;
    let skippedCount = 0;
    
    // Filter out probable headers/junk
    const IGNORED_NAMES = ['Plus New', 'Uncommon', 'Rare', 'Very Rare', 'Legendary', 'Introduction', 'Items by Rarity', 'Common', 'Artifact'];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        
        // CLEAN NAME
        let cleanName = item.name;
        // Remove combined "* Rarity" pattern first
        cleanName = cleanName.replace(/[\*\s]+(Very|Rare|Legendary|Common|Uncommon|Artifact)\s*$/i, '');
        // Remove just Rarity if no *
        cleanName = cleanName.replace(/\s+(Very|Rare|Legendary|Common|Uncommon|Artifact)\s*$/i, '');
        // Remove any remaining trailing * or spaces
        cleanName = cleanName.replace(/[\*\s]+$/, '');
        // Replace smart quotes
        cleanName = cleanName.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
        cleanName = cleanName.trim();

        // TEMPORARY: Only process Rod of arachna for testing
        // if (!cleanName.toLowerCase().includes('arachna')) continue; 
        
        // TEMPORARY: Retrying Staff of Walls
        // if (!cleanName.toLowerCase().includes('staff of walls')) continue; 
        
        // TEMPORARY: Test Specific Items
        // const testItems = ['healer', 'crossbow'];
        // if (!testItems.some(name => cleanName.toLowerCase().includes(name))) continue;

        if (IGNORED_NAMES.includes(cleanName) || cleanName.length > 50 || cleanName.length < 3) {
            // console.log(`Skipping invalid item: ${item.name}`);
            skippedCount++;
            continue;
        }

        const safeName = cleanName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const filename = `${safeName}.jpg`;
        const localPath = `/images/items/${filename}`;
        const fullPath = path.join(IMAGES_DIR, filename);

        // FORCE REGENERATE: Commented out the check for existing files
        if (fs.existsSync(fullPath)) {
            // Update the JSON to point to it if it doesn't already
            if (item.image !== localPath) {
                item.image = localPath;
                updatedCount++;
            }
            continue;
        }

        console.log(`Generating image for [${i + 1}/${items.length}]: ${cleanName}...`);

        let success = false;
        let retries = 0;
        const maxRetries = 5;

        while (!success && retries < maxRetries) {
            try {
                // KEYWORD LOGIC
                let keywords = "";
                // ... (keep existing keyword logic if needed as fallback) ...
                
                let prompt = "";
                
                // 1. Use LLM if enabled (Prioritize LLM for all items including Rod of Arachna)
                if (USE_LLM_PROMPTER) {
                    const llmPrompt = await generatePromptWithLLM(item, cleanName);
                    if (llmPrompt) prompt = llmPrompt;
                }

                // 2. Fallback to Template
                if (!prompt) {
                     // Check for Manual Overrides (Simulated Text AI for specific testing) ONLY if LLM failed or disabled
                     if (cleanName.toLowerCase().includes("rod of arachna")) {
                        prompt = "((dnd fantasy rpg style)), A high-quality digital painting of the 'Rod of Arachna' from Dungeons and Dragons. The item is a **magical rod**, appearing as a long, slender, dark-metal scepter or staff. The handle is wrapped in dark leather. The tip of the rod features a sinister spider motif: a silver spider sitting at the center of a small, vertical web made of metallic filaments. The spider holds a glowing purple amethyst. The item is vertical. White background. No hands. Intricate detail, 8k, (fantasy art:1.2)";
                     } else {
                        const lowerName = cleanName.toLowerCase();
                        keywords += ", ((fantasy art style)), ((dnd concept art)), oil painting, medieval, magical"; // Base fantasy style
                        
                        if (lowerName.includes("arachna") || lowerName.includes("spider") || lowerName.includes("web")) keywords += ", spider web, spider motif, drow aesthetic, dark colors, glowing purple or red eyes, arachnid";
                        if (lowerName.includes("rod") || lowerName.includes("scepter")) keywords += ", magical rod, ornate staff handle, metallic, vertical, scepter, arcane focus";
                        if (lowerName.includes("staff")) keywords += ", long magical wooden staff, wizard staff, druid staff, vertical, full length staff, stick, pole, nature magic";
                        if (lowerName.includes("wand")) keywords += ", magic wand, wooden or metal stick, glowing tip, spellcasting focus";
                        
                        // Elemental/Material keywords for fantasy flavor
                        if (lowerName.includes("fire") || lowerName.includes("flame") || lowerName.includes("burning") || lowerName.includes("ember")) keywords += ", fire magic, flames, glowing orange and red, burnt, heat shimmer";
                        if (lowerName.includes("ice") || lowerName.includes("frost") || lowerName.includes("cold") || lowerName.includes("frozen")) keywords += ", ice crystals, blue glow, frost, frozen, mist, cold";
                        if (lowerName.includes("shadow") || lowerName.includes("dark") || lowerName.includes("night") || lowerName.includes("void")) keywords += ", shadows, purple and black aura, wisps of darkness, obsidian";
                        if (lowerName.includes("holy") || lowerName.includes("divine") || lowerName.includes("light") || lowerName.includes("sun")) keywords += ", radiant light, golden glow, angelic, celestial, clean, pristine";
                        if (lowerName.includes("necro") || lowerName.includes("death") || lowerName.includes("bone") || lowerName.includes("skull")) keywords += ", necromancy, green glow, bones, skulls, decay, ominous";
                        if (lowerName.includes("nature") || lowerName.includes("wild") || lowerName.includes("leaf") || lowerName.includes("vine")) keywords += ", living wood, vines, leaves, green magic, druidic, organic";
                        
                        if (lowerName.includes("plate") && (lowerName.includes("armor") || lowerName.includes("mail"))) keywords += ", full plate armor, chest piece, metallic armor suit, heavy armor, knight armor";
                         if (lowerName.includes("plate") && !lowerName.includes("armor") && !lowerName.includes("mail")) keywords += ", full plate armor, chest piece, metallic armor suit, heavy armor"; // Assume 'plate' usually means armor in this context if not specified otherwise, but be careful of dinner plates (unlikely in DnD items list)
                         if (lowerName.includes("mail") || lowerName.includes("chain")) keywords += ", chainmail armor, metallic mesh, armor suit";
 
                         if (lowerName.includes("sword") || lowerName.includes("blade") || lowerName.includes("scimitar") || lowerName.includes("rapier")) keywords += ", full length sword, sharp blade, weapon, metallic, hilt and blade, vertical";
                         if (lowerName.includes("dagger") || lowerName.includes("knife")) keywords += ", dagger, short sharp blade, weapon, hilt";
                         if (lowerName.includes("axe")) keywords += ", battle axe, heavy weapon, axe head and handle, sharp";
                         if (lowerName.includes("hammer") || lowerName.includes("maul")) keywords += ", warhammer, heavy blunt weapon, hammer head and handle";
                         if (lowerName.includes("bow") && !lowerName.includes("bowl") && !lowerName.includes("crossbow") && !lowerName.includes("elbow")) keywords += ", curved bow, weapon, wooden, string, ranged weapon, full view";
                         if (lowerName.includes("crossbow")) keywords += ", crossbow, mechanical weapon, ranged, wooden stock, metal limbs, trigger mechanism, horizontal";
                         if (lowerName.includes("spear") || lowerName.includes("glaive") || lowerName.includes("halberd") || lowerName.includes("pike") || lowerName.includes("lance")) keywords += ", polearm, long shaft, blade on top, weapon, vertical";
                         
                         if (lowerName.includes("shield")) keywords += ", sturdy shield, defensive gear, heraldry";
                        if (lowerName.includes("ring")) keywords += ", finger ring, jewelry, gemstone, band";
                        if (lowerName.includes("potion") || lowerName.includes("elixir")) keywords += ", glass bottle, liquid inside, cork stopper, alchemy";
                        if (lowerName.includes("boots")) keywords += ", pair of boots, leather footwear";
                        if (lowerName.includes("cloak") || lowerName.includes("cape")) keywords += ", fabric cloak, hood, clothing";
                        if (lowerName.includes("amulet") || lowerName.includes("necklace")) keywords += ", amulet, necklace, jewelry, pendant";

                        prompt = `((dnd fantasy rpg style)), ((single isolated object)), ${cleanName}, ${item.type || 'magical object'}${keywords}, arcane, magical, glowing, intricate detail, masterpiece, digital painting, white background, high quality, fantasy art, still life, centered, full shot`;
                     }
                }

                console.log(`  -> Prompt: ${prompt.substring(0, 100)}...`);

                const negative_prompt = "((person)), ((human)), ((character)), ((face)), ((hands)), ((holding)), ((wearing)), ((body)), ((man)), ((woman)), multiple views, multiple angles, collage, sheet, grid, collection, set, pack, split screen, triptych, diptych, text, watermark, label, bad quality, distorted, ugly, blur, low resolution, multiple items, anatomy, cropped, lowres, error, jpeg artifacts, signature, (photorealistic:1.2), (camera:1.2), circle, round, token, medallion, coin, frame, border, badge, emblem, ui, icon, game piece, portrait, figure, skin, eyes, hair, clothing, armor, limb, arm, leg";

                if (USE_LOCAL_SD) {
                    await generateLocalSD(prompt, negative_prompt, fullPath);
                    // Local gen is usually CPU/GPU intensive, no need for artificial delay unless cooling is needed
                    // But we'll add a tiny one just in case
                    await new Promise(resolve => setTimeout(resolve, 100));
                } else {
                    // Pollinations.ai logic
                    // Add random seed to URL to look like unique requests
                    const seed = Math.floor(Math.random() * 1000000);
                    const models = ['flux', 'turbo'];
                    const model = models[Math.floor(Math.random() * models.length)];
                    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}&model=${model}`;

                    await downloadImage(url, fullPath);
                    // Add a small delay to be nice to the API
                    const waitTime = 2000 + Math.random() * 3000;
                    await new Promise(resolve => setTimeout(resolve, waitTime)); 
                }

                item.image = localPath;
                updatedCount++;
                console.log(`  -> Saved to ${localPath}`);
                success = true;

            } catch (err) {
                if (err.message === "RATE_LIMIT" || err.message.includes("429")) {
                    console.warn(`  -> Rate limit reached! Pausing for 30 seconds... (Attempt ${retries + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30s
                    retries++;
                } else if (err.message.includes("50") || err.message.includes("ECONNREFUSED")) {
                     console.warn(`  -> Error: ${err.message}. Retrying in 5s...`);
                     await new Promise(resolve => setTimeout(resolve, 5000));
                     retries++;
                } else {
                    console.error(`  -> Failed to generate for ${item.name}: ${err.message}`);
                    break; // Non-recoverable error
                }
            }
        }
        
        // Save progress every 5 items
        if (updatedCount % 5 === 0) {
             fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
        }
    }

    // Final Save
    fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
    console.log(`\nDone! Updated ${updatedCount} items. Skipped ${skippedCount}.`);
}

generateImages().catch(console.error);
