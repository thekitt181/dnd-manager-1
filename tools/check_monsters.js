import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));

const targets = monsters.filter(m => 
    (m.name.toUpperCase().includes('MARID') || m.name.toUpperCase().includes('GHOST')) &&
    !m.name.toUpperCase().includes('GHOST DRAGON') // Filter out other ghosts to keep it short
);

console.log("Found:", targets.length);
targets.forEach(m => {
    console.log(`Name: ${m.name}, Image: ${m.image}`);
});
