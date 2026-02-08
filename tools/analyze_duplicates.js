import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');

function getFileHash(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const hashSum = crypto.createHash('md5');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    } catch (e) {
        return null;
    }
}

function main() {
    console.log('Loading monsters.json...');
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));
    
    const hashToMonsters = {};
    const missingFiles = [];

    monsters.forEach(m => {
        if (m.image) {
            const parts = m.image.split('/');
            const filename = parts[parts.length - 1];
            const filePath = path.join(IMAGES_DIR, filename);

            if (fs.existsSync(filePath)) {
                const hash = getFileHash(filePath);
                if (hash) {
                    if (!hashToMonsters[hash]) {
                        hashToMonsters[hash] = [];
                    }
                    hashToMonsters[hash].push({
                        name: m.name,
                        filename: filename,
                        source: m.source
                    });
                }
            } else {
                missingFiles.push(m.name);
            }
        }
    });

    console.log(`Analyzed ${monsters.filter(m => m.image).length} monsters with images.`);
    
    let duplicateGroups = 0;
    let totalDuplicates = 0;

    console.log('\n--- POTENTIAL WRONG ASSIGNMENTS (Shared Image Content) ---');
    for (const [hash, list] of Object.entries(hashToMonsters)) {
        if (list.length > 1) {
            // Check if names are sufficiently different to warrant concern
            // (Ignoring simple variants might be complex, so let's just list them all first)
            console.log(`\nHash ${hash.substring(0, 8)} shared by ${list.length} monsters:`);
            list.forEach(item => console.log(`  - ${item.name} (${item.filename})`));
            duplicateGroups++;
            totalDuplicates += list.length;
        }
    }

    console.log(`\nFound ${duplicateGroups} groups of identical images covering ${totalDuplicates} monsters.`);
}

main();
