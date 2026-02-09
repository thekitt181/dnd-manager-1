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
            const tds = $(row).find('td');
            // The name is in a link, usually the first column.
            const linkTag = $(row).find('td a').first();
            
            if (linkTag.length && tds.length > 0) {
                const name = linkTag.text().trim();
                const href = linkTag.attr('href'); // e.g., "../dnd/monsters.php?vo=aboleth"
                
                // Source is the last column based on the user's screenshot
                let source = $(tds[tds.length - 1]).text().trim();

                if (name && href) {
                    links.push({ name, href, source });
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

            // Determine Source Directory from Aidedd Data (Priority)
            let sourceDir = 'Other';
            let finalSource = 'Other';

            if (link.source) {
                let rawSource = link.source.trim();
                
                // Rule 1: "Monster Manual (BR)" or "(SD)" -> "Monster Manual"
                if (rawSource.startsWith("Monster Manual")) {
                    finalSource = "Monster Manual";
                    sourceDir = "Monster_Manual";
                } 
                // Rule 2: "Adventures (Tomb of Annihilation)" -> New folder "Adventures_Tomb_of_Annihilation"
                else {
                    finalSource = rawSource;
                    sourceDir = rawSource.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/_$/, "");
                }
            } else if (targets && targets.length > 0 && targets[0].source) {
                 // Fallback to local source if Aidedd source is missing
                 finalSource = targets[0].source;
                 sourceDir = targets[0].source.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
            }

            // Prepare to update or create entry
            let monsterEntry = null;
            if (targets && targets.length > 0) {
                monsterEntry = targets[0];
            } else {
                // Create new entry if not exists
                monsterEntry = {
                    name: link.name,
                    source: finalSource,
                    image: null // Will set below
                };
                monstersData.push(monsterEntry);
                // Add to map to prevent duplicates in this run
                if (!monsterMap[normName]) monsterMap[normName] = [];
                monsterMap[normName].push(monsterEntry);
            }

            // Create source directory
            const sourcePath = path.join(OUTPUT_DIR, sourceDir);
            if (!fs.existsSync(sourcePath)) {
                fs.mkdirSync(sourcePath, { recursive: true });
            }

            const targetFilename = `${link.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`; // Standardize filename
            const filePath = path.join(sourcePath, targetFilename);
            const relativeImagePath = `images/monsters/${sourceDir}/${targetFilename}`;

            console.log(`Processing [${processed + 1}/${links.length}]: ${link.name} (Source: ${sourceDir})...`);
            
            // Fix relative URL
            let detailUrl = link.href;
            if (detailUrl.startsWith('..')) {
                detailUrl = 'https://www.aidedd.org' + detailUrl.substring(2);
            } else if (!detailUrl.startsWith('http')) {
                 detailUrl = 'https://www.aidedd.org/dnd/' + detailUrl;
            }
            
            // Check if we already have this image and it's good (optional, but skipping saves time)
            // But user might want to overwrite if "start over" was requested. 
            // We'll proceed to download to ensure we get the right one.

            try {
                const detailResp = await axios.get(detailUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                });
                const $$ = cheerio.load(detailResp.data);
                
                // Find image
                const imgTag = $$('img[src*="dnd/images"]').first();
                const imgSrc = imgTag.attr('src');

                if (imgSrc) {
                    console.log(`   Found image: ${imgSrc}`);
                    
                    const imgResp = await axios.get(imgSrc, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(imgResp.data);

                    console.log(`   Removing background...`);
                    try {
                        const pngBuffer = await removeBackground(buffer, 30);
                        fs.writeFileSync(filePath, pngBuffer);
                        console.log(`   Saved to ${filePath}`);
                        downloaded++;
                        
                        // Update monster entry
                        monsterEntry.image = relativeImagePath;
                        monsterEntry.source = finalSource; // Update source to match Aidedd if needed

                    } catch (bgErr) {
                        console.warn(`   Background removal failed, saving original:`, bgErr.message);
                        fs.writeFileSync(filePath, buffer);
                        monsterEntry.image = relativeImagePath;
                        monsterEntry.source = finalSource;
                    }
                } else {
                    console.log(`   No image found on detail page.`);
                    skipped++;
                }

            } catch (err) {
                console.error(`   Error processing ${link.name}:`, err.message);
                errors++;
            }
            
            // Periodically save monsters.json (every 10 items) to avoid data loss
            if (processed % 10 === 0) {
                fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monstersData, null, 2));
            }
            
            await new Promise(r => setTimeout(r, 500)); 
            processed++;
        }

        // Final save
        fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monstersData, null, 2));
        console.log(`Done. Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`);
        console.log(`Updated monsters.json with new images/entries.`);

    } catch (err) {
        console.error("Fatal error:", err);
    }
}

scrape();
