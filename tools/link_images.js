import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');
const BASE_URL = 'images/'; // Use relative path for portability

// Check if files exist
if (!fs.existsSync(MONSTERS_FILE)) {
    console.error(`Monsters file not found at ${MONSTERS_FILE}`);
    process.exit(1);
}

if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`Images directory not found at ${IMAGES_DIR}`);
    process.exit(1);
}

// Read Data
const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));

// Recursive function to get all image files
function getFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getFiles(filePath));
        } else {
            // Store relative path from IMAGES_DIR
            const relativePath = path.relative(IMAGES_DIR, filePath).replace(/\\/g, '/');
            results.push(relativePath);
        }
    });
    return results;
}

const imageFiles = getFiles(IMAGES_DIR);

console.log(`Loaded ${monsters.length} monsters.`);
console.log(`Found ${imageFiles.length} images in ${IMAGES_DIR}.`);

let updatedCount = 0;
let missingCount = 0;

// Helper to normalize monster name
function normalize(name) {
    return name.toLowerCase()
        .replace(/['’]/g, '') // Remove quotes
        .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
        .replace(/^_+|_+$/g, ''); // Trim underscores
}

monsters.forEach(monster => {
    const normalizedName = normalize(monster.name);
    
    // Find matching image
    // Strategy: 
    // 1. Exact match (e.g. "aatxe.png")
    // 2. Prefix match with underscore (e.g. "aatxe_12345.png")
    
    let match = imageFiles.find(fileRelPath => {
        const fileName = path.basename(fileRelPath);
        const fileBase = path.parse(fileName).name.toLowerCase(); // aatxe_12345
        
        // Check for exact match
        if (fileBase === normalizedName) return true;
        
        // Check for timestamp suffix match (must be followed by underscore and digits)
        if (fileBase.startsWith(normalizedName + '_')) {
             // Check if the rest is just digits (timestamp)
             const suffix = fileBase.substring(normalizedName.length + 1);
             if (/^\d+$/.test(suffix)) return true;
        }
        
        return false;
    });

    if (match) {
        monster.image = `${BASE_URL}${match}`;
        updatedCount++;
        // console.log(`[OK] ${monster.name} -> ${match}`);
    } else {
        missingCount++;
        // Try fuzzy match? (Contains?)
        // Let's not be too aggressive to avoid false positives.
        // console.log(`[MISSING] No image found for: ${monster.name} (normalized: ${normalizedName})`);
    }
});

// Write back
fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));

console.log('------------------------------------------------');
console.log(`Process Complete.`);
console.log(`Updated: ${updatedCount}`);
console.log(`Missing: ${missingCount}`);
console.log(`Total: ${monsters.length}`);
