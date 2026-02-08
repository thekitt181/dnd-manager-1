import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');
const TRASH_DIR = path.join(__dirname, '../public/images_trash');

if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
}

// Stop words to ignore when checking for similarity
const STOP_WORDS = new Set([
    'adult', 'ancient', 'young', 'greater', 'lesser', 'elder', 'common', 'giant',
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'and', 'or',
    'black', 'blue', 'green', 'red', 'white', 'brown', 'gold', 'silver', 'bronze', 'copper', 'brass', 'gray', 'grey',
    'purple', 'yellow', 'orange', 'pink', 'dark', 'light', 'pale', 'deep', 'iron', 'stone', 'clay', 'flesh',
    'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'
]);

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

function tokenize(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function main() {
    console.log('Loading monsters.json...');
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));
    
    // 1. Group by Content Hash
    const hashToMonsters = {};
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
                    hashToMonsters[hash].push({ monster: m, filename: filename });
                }
            }
        }
    });

    let deletedFiles = 0;
    let updatedMonsters = 0;

    console.log('\n--- Processing Duplicate Groups ---');

    for (const [hash, list] of Object.entries(hashToMonsters)) {
        if (list.length > 1) {
            const names = list.map(i => i.monster.name);
            
            // Check intersection of tokens
            const tokenSets = names.map(n => new Set(tokenize(n)));
            
            // Start with first set and intersect with rest
            let intersection = tokenSets[0];
            for (let i = 1; i < tokenSets.length; i++) {
                intersection = new Set([...intersection].filter(x => tokenSets[i].has(x)));
            }

            // Decision Logic
            const commonTokens = [...intersection];
            const isHomogeneous = commonTokens.length > 0;

            if (!isHomogeneous) {
                console.log(`\n[DELETE] Heterogeneous Group (${list.length}): ${names.join(', ')}`);
                console.log(`         (No common significant tokens found)`);

                // Delete ALL files in this group
                const filesToDelete = new Set(list.map(i => i.filename));
                filesToDelete.forEach(file => {
                    const src = path.join(IMAGES_DIR, file);
                    const dest = path.join(TRASH_DIR, file);
                    if (fs.existsSync(src)) {
                        try {
                            fs.renameSync(src, dest);
                            deletedFiles++;
                        } catch (e) {
                            console.error(`Error moving ${file}: ${e.message}`);
                        }
                    }
                });

                // Update Monsters
                list.forEach(item => {
                    item.monster.image = null;
                    updatedMonsters++;
                });

            } else {
                console.log(`\n[KEEP] Homogeneous Group (${list.length}): ${names.join(', ')}`);
                console.log(`       (Common: ${commonTokens.join(', ')})`);
            }
        }
    }

    if (updatedMonsters > 0) {
        fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
        console.log(`\nSummary: Deleted ${deletedFiles} files. Unlinked ${updatedMonsters} monsters.`);
    } else {
        console.log(`\nSummary: No changes made.`);
    }
}

main();
