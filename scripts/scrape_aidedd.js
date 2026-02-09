import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { removeBackground } from './utils/background_remover.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const OUTPUT_DIR = path.join(__dirname, '../public/images/monsters');
const BASE_URL = 'https://www.aidedd.org/dnd-filters/monsters.php';
const DETAIL_BASE_URL = 'https://www.aidedd.org/dnd/';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Helper: Normalize name for matching
function normalize(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function scrape() {
    console.log("Loading monsters.json...");
    const monstersData = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));
    
    // Filter for Monster Manual or just all? User said "fill in images for monster manual pdf"
    // But we probably want to match as many as possible.
    // Let's create a map of normalized name -> monster object(s)
    const monsterMap = {};
    monstersData.forEach(m => {
        const norm = normalize(m.name);
        if (!monsterMap[norm]) monsterMap[norm] = [];
        monsterMap[norm].push(m);
    });

    console.log(`Loaded ${monstersData.length} monsters.`);
    console.log(`Fetching monster list from ${BASE_URL}...`);

    try {
        const response = await axios.get(BASE_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(response.data);
        
        const links = [];
        
        // The table rows are in a table.sortable
        $('table tr').each((i, row) => {
            const linkTag = $(row).find('td a');
            if (linkTag.length) {
                const name = linkTag.text().trim();
                const href = linkTag.attr('href'); // e.g., "../dnd/monsters.php?vo=aboleth"
                if (name && href) {
                    links.push({ name, href });
                }
            }
        });

        console.log(`Found ${links.length} monsters on Aidedd.`);
        if (links.length > 0) {
            console.log("Sample link href:", links[0].href);
        }

        let processed = 0;
        let downloaded = 0;
        let skipped = 0;
        let errors = 0;

        for (const link of links) {
            const normName = normalize(link.name);
            const targets = monsterMap[normName];

            if (targets && targets.length > 0) {
                // Check if we already have an image for this monster (optional, but good for speed)
                // Actually, user wants to "fill in", so maybe skip if exists?
                // But previous generated images might be "janky", so let's overwrite or check logic.
                // For now, let's try to download.
                
                const monster = targets[0];
                let sourceDir = 'Other';
                
                // Determine source directory
                if (monster.source) {
                    // Clean source name (e.g. "Creature_Codex.pdf" -> "Creature_Codex")
                    sourceDir = monster.source.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
                }
                
                // Create source directory if it doesn't exist
                const sourcePath = path.join(OUTPUT_DIR, sourceDir);
                if (!fs.existsSync(sourcePath)) {
                    fs.mkdirSync(sourcePath, { recursive: true });
                }

                const targetFilename = `${monster.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`; // Standardize filename
                const filePath = path.join(sourcePath, targetFilename);
                
                // If it exists, maybe skip? 
                // User said "start over" previously. Let's assume we want these high quality images.
                // But let's check if the file size is small (placeholder) or if we want to force update.
                // I'll force update for now as requested.

                console.log(`Processing [${processed + 1}/${links.length}]: ${link.name} (Source: ${sourceDir})...`);
                
                // Fix relative URL
                // href is like "../dnd/monsters.php?vo=..." or "monsters.php?vo=..."
                // The base is https://www.aidedd.org/dnd-filters/monsters.php
                // If href starts with .., it goes to https://www.aidedd.org/dnd/monsters.php
                
                let detailUrl = link.href;
                if (detailUrl.startsWith('..')) {
                    detailUrl = 'https://www.aidedd.org' + detailUrl.substring(2);
                } else if (!detailUrl.startsWith('http')) {
                    // Assume relative to current path if no ..
                    // If it's just "monsters.php?vo=...", it might be dnd-filters/monsters.php?vo=...
                    // But likely it's meant to be dnd/monsters.php.
                    // Let's rely on the sample log if this fails.
                    // But actually, if it's "monsters.php?vo=...", the 404s suggest it's NOT under dnd-filters.
                    // Let's try prepending https://www.aidedd.org/dnd/ if it doesn't start with ..
                     detailUrl = 'https://www.aidedd.org/dnd/' + detailUrl;
                }
                
                console.log(`   URL: ${detailUrl}`);

                try {
                    const detailResp = await axios.get(detailUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                    });
                    const $$ = cheerio.load(detailResp.data);
                    
                    // Find image. usually <img src="https://www.aidedd.org/dnd/images/..." ...>
                    // Selector: img[src*="dnd/images"]
                    const imgTag = $$('img[src*="dnd/images"]').first();
                    const imgSrc = imgTag.attr('src');

                    if (imgSrc) {
                        console.log(`   Found image: ${imgSrc}`);
                        
                        // Download
                        const imgResp = await axios.get(imgSrc, { responseType: 'arraybuffer' });
                        const buffer = Buffer.from(imgResp.data);

                        // Remove Background (Tolerance 30 default is good, maybe 20 for illustrations)
                        console.log(`   Removing background...`);
                        try {
                            const pngBuffer = await removeBackground(buffer, 30);
                            fs.writeFileSync(filePath, pngBuffer);
                            console.log(`   Saved to ${filePath}`);
                            downloaded++;
                        } catch (bgErr) {
                            console.warn(`   Background removal failed, saving original (converted to png if possible, else raw):`, bgErr.message);
                            fs.writeFileSync(filePath, buffer); // Might be jpg
                        }
                    } else {
                        console.log(`   No image found on detail page.`);
                        skipped++;
                    }

                } catch (err) {
                    console.error(`   Error processing ${link.name}:`, err.message);
                    errors++;
                }
                
                // Polite delay
                await new Promise(r => setTimeout(r, 500)); 

            } else {
                // No match in our monsters.json
                // console.log(`Skipping ${link.name} (no match in local DB)`);
            }
            processed++;
        }

        console.log(`Done. Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`);

    } catch (err) {
        console.error("Fatal error:", err);
    }
}

scrape();
