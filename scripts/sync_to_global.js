
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const API_URL = 'https://dnd-manager-1.onrender.com/api/data';

async function sync() {
    console.log("Reading local monsters.json...");
    const localMonsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));
    console.log(`Local monsters count: ${localMonsters.length}`);

    console.log(`Fetching current global data from ${API_URL}...`);
    try {
        const response = await axios.get(API_URL);
        const currentData = response.data;
        
        console.log("Current Global Data Stats:");
        console.log(`- Monsters: ${currentData.monsters ? currentData.monsters.length : 0}`);
        console.log(`- Items: ${currentData.items ? currentData.items.length : 0}`);
        console.log(`- Deleted: ${currentData.deleted ? currentData.deleted.length : 0}`);

        // Prepare new payload
        // We replace monsters with our local copy, but preserve items and deleted from server
        const payload = {
            monsters: localMonsters,
            items: currentData.items || [],
            deleted: currentData.deleted || [],
            images: currentData.images || {}
        };

        console.log("Syncing to global...");
        // Use a large limit if needed, though axios usually handles it. 
        // Note: The server has a 50mb limit which should be fine for text JSON.
        
        const postResponse = await axios.post(API_URL, payload, {
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (postResponse.data.success) {
            console.log("Sync successful!");
        } else {
            console.log("Sync response:", postResponse.data);
        }

    } catch (err) {
        console.error("Sync failed:", err.message);
        if (err.response) {
            console.error("Response data:", err.response.data);
        }
    }
}

sync();
