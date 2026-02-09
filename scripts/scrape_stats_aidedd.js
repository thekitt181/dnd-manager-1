
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
    let monstersData = [];
    if (fs.existsSync(MONSTERS_FILE)) {
        monstersData = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));
    }
    
    // Create a map for quick lookup
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
        
        $('table tr').each((i, row) => {
            const tds = $(row).find('td');
            const linkTag = $(row).find('td a').first();
            
            if (linkTag.length && tds.length > 0) {
                const name = linkTag.text().trim();
                const href = linkTag.attr('href');
                let source = $(tds[tds.length - 1]).text().trim();

                if (name && href) {
                    links.push({ name, href, source });
                }
            }
        });

        console.log(`Found ${links.length} monsters on Aidedd.`);

        let processed = 0;
        let downloaded = 0;
        let updated = 0;
        let errors = 0;

        for (const link of links) {
            const normName = normalize(link.name);
            const targets = monsterMap[normName];

            // Determine Source Directory
            let sourceDir = 'Other';
            let finalSource = 'Other';

            if (link.source) {
                let rawSource = link.source.trim();
                if (rawSource.startsWith("Monster Manual")) {
                    finalSource = "Monster Manual";
                    sourceDir = "Monster_Manual";
                } else {
                    console.log(`Skipping ${link.name} (Source: ${rawSource}) - Focusing on Monster Manual.`);
                    continue;
                }
            } else if (targets && targets.length > 0 && targets[0].source) {
                 finalSource = targets[0].source;
                 sourceDir = targets[0].source.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
            }

            // Prepare entry
            let monsterEntry = null;
            if (targets && targets.length > 0) {
                monsterEntry = targets[0];
            } else {
                monsterEntry = {
                    name: link.name,
                    source: finalSource,
                    image: null
                };
                monstersData.push(monsterEntry);
                if (!monsterMap[normName]) monsterMap[normName] = [];
                monsterMap[normName].push(monsterEntry);
            }

            // Update source if needed
            monsterEntry.source = finalSource;

            // Paths
            const sourcePath = path.join(OUTPUT_DIR, sourceDir);
            if (!fs.existsSync(sourcePath)) {
                fs.mkdirSync(sourcePath, { recursive: true });
            }
            const targetFilename = `${link.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
            const filePath = path.join(sourcePath, targetFilename);
            const relativeImagePath = `images/monsters/${sourceDir}/${targetFilename}`;

            console.log(`Processing [${processed + 1}/${links.length}]: ${link.name}...`);
            
            // Fix URL
            let detailUrl = link.href;
            if (detailUrl.startsWith('..')) {
                detailUrl = 'https://www.aidedd.org' + detailUrl.substring(2);
            } else if (!detailUrl.startsWith('http')) {
                 detailUrl = 'https://www.aidedd.org/dnd/' + detailUrl;
            }

            try {
                const detailResp = await axios.get(detailUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                });
                const $$ = cheerio.load(detailResp.data);
                
                // --- Stat Parsing Logic ---
                const statBlock = $$('.sansSerif');
                if (statBlock.length) {
                    // Type
                    const type = statBlock.find('.type').text().trim();
                    if (type) monsterEntry.type = type;

                    // Red Div (AC, HP, Speed)
                    const redDiv = statBlock.find('.red').first();
                    const redText = redDiv.html();
                    if (redText) {
                        const parts = redText.split('<br>');
                        parts.forEach(part => {
                            const cleanPart = $$(`<div>${part}</div>`).text().trim();
                            if (cleanPart.startsWith('Armor Class')) {
                                const acStr = cleanPart.replace('Armor Class', '').trim();
                                monsterEntry.ac = parseInt(acStr) || acStr;
                            }
                            if (cleanPart.startsWith('Hit Points')) {
                                const hpStr = cleanPart.replace('Hit Points', '').trim();
                                monsterEntry.hp = parseInt(hpStr) || hpStr;
                                // Ideally store full string somewhere if needed, but int is standard for 'hp' field
                            }
                            if (cleanPart.startsWith('Speed')) {
                                monsterEntry.speed = cleanPart.replace('Speed', '').replace(/(STR|DEX|CON|INT|WIS|CHA).*$/, '').trim();
                            }
                        });
                    }

                    // Ability Scores
                    const caracElements = statBlock.find('.carac');
                    if (caracElements.length === 6) {
                        monsterEntry.stats = {
                            str: parseInt(caracElements.eq(0).text().match(/(\d+)/)?.[0]) || 10,
                            dex: parseInt(caracElements.eq(1).text().match(/(\d+)/)?.[0]) || 10,
                            con: parseInt(caracElements.eq(2).text().match(/(\d+)/)?.[0]) || 10,
                            int: parseInt(caracElements.eq(3).text().match(/(\d+)/)?.[0]) || 10,
                            wis: parseInt(caracElements.eq(4).text().match(/(\d+)/)?.[0]) || 10,
                            cha: parseInt(caracElements.eq(5).text().match(/(\d+)/)?.[0]) || 10
                        };
                    }

                    // CR
                    const crText = statBlock.text().match(/Challenge\s+([\d/]+)/);
                    if (crText) monsterEntry.cr = crText[1];

                    // Full Description (Traits + Actions)
                    let description = "";
                    // Reconstruct description with speed first if not present
                    if (monsterEntry.speed) description += `Speed ${monsterEntry.speed}\n`;
                    
                    // Add ability scores line for compatibility
                    if (monsterEntry.stats) {
                        description += "STR DEX CON INT WIS CHA\n";
                        description += `${monsterEntry.stats.str} (${Math.floor((monsterEntry.stats.str-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.str-10)/2)}) `;
                        description += `${monsterEntry.stats.dex} (${Math.floor((monsterEntry.stats.dex-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.dex-10)/2)}) `;
                        description += `${monsterEntry.stats.con} (${Math.floor((monsterEntry.stats.con-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.con-10)/2)}) `;
                        description += `${monsterEntry.stats.int} (${Math.floor((monsterEntry.stats.int-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.int-10)/2)}) `;
                        description += `${monsterEntry.stats.wis} (${Math.floor((monsterEntry.stats.wis-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.wis-10)/2)}) `;
                        description += `${monsterEntry.stats.cha} (${Math.floor((monsterEntry.stats.cha-10)/2)>=0?'+':''}${Math.floor((monsterEntry.stats.cha-10)/2)})\n`;
                    }

                    statBlock.children().each((i, el) => {
                        const $el = $$(el);
                        // Skip header elements we already parsed or don't want
                        if ($el.hasClass('type') || $el.hasClass('red') || $el.find('svg').length || $el.hasClass('carac')) return;
                        
                        const text = $el.text().trim();
                        if (!text) return;
                        description += text + "\n\n";
                    });

                    monsterEntry.description = description.trim();
                    updated++;
                }

                // --- Image Handling ---
                // Only download if missing or we want to ensure it's there. 
                // Let's check if image file exists.
                if (!fs.existsSync(filePath)) {
                    const imgTag = $$('img[src*="dnd/images"]').first();
                    const imgSrc = imgTag.attr('src');

                    if (imgSrc) {
                        console.log(`   Downloading image: ${imgSrc}`);
                        const imgResp = await axios.get(imgSrc, { responseType: 'arraybuffer' });
                        const buffer = Buffer.from(imgResp.data);

                        try {
                            const pngBuffer = await removeBackground(buffer, 30);
                            fs.writeFileSync(filePath, pngBuffer);
                            downloaded++;
                            monsterEntry.image = relativeImagePath;
                        } catch (bgErr) {
                            console.warn(`   Background removal failed, saving original:`, bgErr.message);
                            fs.writeFileSync(filePath, buffer);
                            monsterEntry.image = relativeImagePath;
                        }
                    }
                } else {
                    // Ensure path is correct in JSON even if file exists
                    monsterEntry.image = relativeImagePath;
                }

            } catch (err) {
                console.error(`   Error processing ${link.name}:`, err.message);
                errors++;
            }
            
            // Save every 10 monsters to prevent data loss on crash
            if (processed % 10 === 0) {
                try {
                    fs.writeFileSync(path.join(__dirname, '../src/monsters_updated.json'), JSON.stringify(monstersData, null, 2));
                    console.log(`Saved progress (Processed: ${processed})`);
                } catch (err) {
                    console.error(`Error saving progress: ${err.message}`);
                }
            }
            
            // Be nice to the server
            await new Promise(r => setTimeout(r, 200)); 
            processed++;
        }
        
        // Final save
        fs.writeFileSync(path.join(__dirname, '../src/monsters_updated.json'), JSON.stringify(monstersData, null, 2));
        console.log("Final save complete to monsters_updated.json");
        console.log(`Done. Updated Stats: ${updated}, Downloaded Images: ${downloaded}, Errors: ${errors}`);

    } catch (err) {
        console.error("Fatal error:", err);
    }
}

scrape();
