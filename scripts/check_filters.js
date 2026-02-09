
import axios from 'axios';
import * as cheerio from 'cheerio';

async function checkFilters() {
    try {
        const response = await axios.get('https://www.aidedd.org/dnd-filters/monsters.php', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(response.data);
        
        console.log("Searching for filter inputs...");
        $('input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).attr('value');
            const id = $(el).attr('id');
            const nextText = $(el).next().text().trim();
            const parentText = $(el).parent().text().trim();
            
            if (parentText.includes('Tomb') || parentText.includes('Annihilation') || (value && value.includes('ToA'))) {
                console.log(`Found Input: name=${name}, value=${value}, text=${parentText}`);
            }
        });

        console.log("Searching for links with parameters...");
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes('ToA') || href.includes('Annihilation'))) {
                console.log(`Found Link: ${href}`);
            }
        });

    } catch (err) {
        console.error(err);
    }
}

checkFilters();
