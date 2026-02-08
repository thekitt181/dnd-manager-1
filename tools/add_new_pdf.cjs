
const fs = require('fs');
const path = require('path');
const { processPdf } = require('./extract_monsters.cjs');

const PDF_DIR = path.join(__dirname, '../pdfs');
const OUTPUT_FILE = path.join(__dirname, '../src/monsters.json');
const NEW_PDF_NAME = 'LegendaryDragons_PDF_v001.5-sm_5d006e4f7ffd7.pdf';

async function main() {
    const pdfPath = path.join(PDF_DIR, NEW_PDF_NAME);
    if (!fs.existsSync(pdfPath)) {
        console.error(`PDF not found: ${pdfPath}`);
        return;
    }

    // 1. Load existing monsters
    console.log("Loading existing monsters...");
    let existingMonsters = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        existingMonsters = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    }
    console.log(`Loaded ${existingMonsters.length} existing monsters.`);

    // 2. Process new PDF
    console.log(`Processing new PDF: ${NEW_PDF_NAME}...`);
    const newMonsters = await processPdf(pdfPath);
    console.log(`Extracted ${newMonsters.length} monsters from new PDF.`);

    // 3. Merge
    // We want to add new monsters. If a monster with the same name exists, 
    // we generally assume the existing one is fine, OR we could update it.
    // The original script merges by appending descriptions and upgrading stats.
    // Let's replicate a simple merge: Add if new, update if better stats.
    
    const monsterMap = new Map();
    
    // Load existing into map
    existingMonsters.forEach(m => monsterMap.set(m.name, m));
    
    let addedCount = 0;
    let updatedCount = 0;

    for (const m of newMonsters) {
        // Clean name (same logic as original script)
        const cleanName = m.name.replace(/[^\w\s'-]/g, '').trim();
        if (cleanName.length < 3) continue;
        m.name = cleanName;

        if (monsterMap.has(cleanName)) {
            const existing = monsterMap.get(cleanName);
            let changed = false;

            // Update stats if new ones are better (not default)
            if ((existing.ac === 10 && existing.hp === 10) && (m.ac !== 10 || m.hp !== 10)) {
                existing.ac = m.ac;
                existing.hp = m.hp;
                existing.type = m.type;
                existing.cr = m.cr;
                changed = true;
            }

            // Append description if new
            if (m.description && !existing.description.includes(m.description.substring(0, 50))) {
                existing.description += "\n\n" + m.description;
                changed = true;
            }

            // Append source
            if (!existing.source.includes(m.source)) {
                existing.source += ", " + m.source;
                changed = true;
            }
            
            if (changed) updatedCount++;

        } else {
            monsterMap.set(cleanName, m);
            addedCount++;
        }
    }

    const finalMonsters = Array.from(monsterMap.values());

    // 4. Save
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalMonsters, null, 2));
    console.log(`\nSuccess! Added ${addedCount} new, Updated ${updatedCount} existing.`);
    console.log(`Total monsters: ${finalMonsters.length}`);
}

main();
