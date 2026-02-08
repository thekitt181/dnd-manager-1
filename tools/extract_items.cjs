
const fs = require('fs');
const path = require('path');
let pdf = require('pdf-parse');

if (typeof pdf !== 'function' && pdf.default) {
    pdf = pdf.default;
}

const PDF_DIR = 'C:\\Users\\plebi\\Desktop\\dnd item book';
const OUTPUT_FILE = path.join(__dirname, '../src/items.json');

const RENDER_OPTIONS = {
    normalizeWhitespace: true,
    disableCombineTextItems: false
};

// Same render function as monsters to detect headers by font size
const render_page = async (pageData) => {
    const textContent = await pageData.getTextContent(RENDER_OPTIONS);
    let text = '';
    let lastY;
    let currentLine = '';
    let maxFontSize = 0;

    for (const item of textContent.items) {
        const tx = item.transform;
        const y = tx[5]; 
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
        
        if (lastY === undefined || Math.abs(y - lastY) < 2.0) {
            currentLine += item.str; 
            if (fontSize > maxFontSize) maxFontSize = fontSize;
        } else {
            if (currentLine.trim().length > 0) {
                if (maxFontSize > 10.5) {
                    text += `\n###HEADER:${maxFontSize.toFixed(2)}###${currentLine}`;
                } else {
                    text += `\n${currentLine}`;
                }
            }
            currentLine = item.str;
            maxFontSize = fontSize;
        }
        lastY = y;
    }
    
    if (currentLine.trim().length > 0) {
        if (maxFontSize > 10.5) {
            text += `\n###HEADER:${maxFontSize.toFixed(2)}###${currentLine}`;
        } else {
            text += `\n${currentLine}`;
        }
    }
    
    return text;
}

// Helper to clean weird PDF artifacts (e.g. $ instead of space, ! in headers)
function cleanLine(line) {
    // Replace $ with space (common artifact in 50_New_Magic_Items)
    let cleaned = line.replace(/\$/g, ' ');
    
    // If it looks like a header with ! instead of spaces (e.g. "Angel’s!Call!"), fix it
    // But be careful not to break "Hit!" or similar.
    // Headers usually don't have ! in the middle unless it's this specific artifact.
    // Check if line is ###HEADER...
    if (cleaned.startsWith('###HEADER')) {
        const parts = cleaned.split('###');
        if (parts.length >= 3) {
            let content = parts[2];
            // Replace ! with space, but trim trailing space
            content = content.replace(/!/g, ' ').trim();
            cleaned = `${parts[0]}###${parts[1]}###${content}`;
        }
    }
    return cleaned;
}

function extractItems(text, source) {
    const items = [];
    // Normalize text first
    // Replace % with space (another artifact seen in debug: "More%resources...")
    let rawLines = text.replace(/%/g, ' ').split(/\r?\n/);
    
    let lines = rawLines.map(l => cleanLine(l.trim())).filter(l => l.length > 0);
    
    let currentItem = null;
    let itemStartIndex = -1;

    // Regex to identify Item Type/Rarity line
    // e.g. "Wondrous item, rare"
    // e.g. "Weapon (longsword), legendary (requires attunement)"
    // e.g. "Spy fly* Uncommon" (Space separator)
    // e.g. "Aeon Stone... rarity varies"
    // e.g. "COMMONWondrous item" (Artifacts of the Guild artifact)
    const rarityRegex = /^(.*)[,\s.-]\s*(?:rarity\s+)?(common|uncommon|rare|very rare|legendary|artifact|varies)/i;
    
    // Special regex for "RARITYType" format (Artifacts of the Guild)
    const reversedRarityRegex = /^(common|uncommon|rare|very rare|legendary|artifact)(?:\s*|(?=[A-Z]))(.*)/i;

    const isTypeLine = (line) => {
        const clean = line.replace(/^###HEADER:[\d.]+###/, '');
        // Must match rarity regex
        // AND must NOT look like a sentence (too long, ends with period)
        if (clean.length > 80) return false;
        if (clean.endsWith('.')) return false; 
        
        if (rarityRegex.test(clean)) return true;
        if (reversedRarityRegex.test(clean)) return true;
        
        return false;
    };

    const isHeaderLine = (line) => {
        // Headers must be marked, OR be All Caps and short (fallback for some PDFs)
        if (line.startsWith('###HEADER:')) return true;
        return false;
    };
    
    // START/STOP Logic for specific files
    let extractionEnabled = true;
    if (source.includes('50_New_Magic_Items')) {
        extractionEnabled = false; 
    }
    // DMG always enabled, we rely on garbage filtering? 
    // No, DMG has too much text before items.
    // The previous dump showed: [FS:9.48] Magic Items .................................................................. 135
    // But later pages weren't dumped.
    // Let's assume the string is "Magic Items A–Z" (En dash?) or something.
    // Let's just enable DMG from line 0 but rely on detection of Item Headers?
    // But DMG has "Chapter 7: Treasure" which might look like a header.
    // Let's try to find "Adamantine Armor" specifically to start?
    if (source.includes('dungeon-master')) {
        extractionEnabled = false; 
    }
    
    // Categories to ignore in 50_New_Magic_Items and others
    const IGNORE_HEADERS = new Set([
        'RINGS', 'WANDS', 'STAFFS', 'RODS', 'SCROLLS', 'POTIONS', 
        'WONDROUS ITEMS', 'WEAPONS', 'ARMOR', 'CANTRIPS', 'SPELLS',
        'TABLE OF CONTENTS', 'INDEX', 'CREDITS', 'MAGIC ITEMS', 'CONTENTS', 'APPENDIX',
        'ITEM RARITY', 'ITEMS BY RARITY', 'ITEMS BY TYPE', 'NEW MAGIC ITEMS'
    ]);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cleanL = line.replace(/^###HEADER:[\d.]+###/, '').trim();
        
        // Control Extraction for 50_New_Magic_Items
        if (source.includes('50_New_Magic_Items')) {
            if (cleanL.includes('New Magic Items') && isHeaderLine(line)) {
                extractionEnabled = true;
                continue;
            }
            if (cleanL.includes('More resources at')) continue;
            if (/^\d+$/.test(cleanL) || /\.{3,}/.test(cleanL)) continue;
        }
        
        // Control Extraction for DMG
        if (source.includes('dungeon-master')) {
            // "Magic Items A-Z" or "Adamantine Armor"
            if (cleanL.includes('Magic Items A') || cleanL.includes('ADAMANTINE ARMOR')) {
                extractionEnabled = true;
                console.log(`[DEBUG] DMG Extraction Started at line: ${cleanL}`);
            }
            // Also enable if we see "Adamantine Armor" specifically
            if (cleanL.toUpperCase().includes('ADAMANTINE ARMOR')) {
                 extractionEnabled = true;
            }
            
            if (cleanL.includes('Sentient Magic Items')) {
                extractionEnabled = false;
            }
        }

        if (!extractionEnabled) continue;

        // Skip Garbage Headers
        if (isHeaderLine(line) && IGNORE_HEADERS.has(cleanL.toUpperCase())) continue;

        // Skip Garbage
        if (['TABLE OF CONTENTS', 'INDEX', 'CREDITS', 'MAGIC ITEMS', 'CONTENTS', 'APPENDIX'].some(x => cleanL.toUpperCase().includes(x))) continue;
        if (cleanL.match(/^Part \d/i) || cleanL.match(/^Chapter \d/i)) continue;
        
        // Skip page numbers
        if (/^\d+$/.test(cleanL)) continue;

        // Check for Item Start
        // Like monsters, we look for a Header followed by a Type Line
        // Or just a Type Line if the Header was missed (but strictly valid Name)
        
        let potentialStart = false;
        let typeLineIndex = -1;
        let isOneLineItem = false;

        // Case 1: Header + Type on SAME line (e.g. "Spy fly* Uncommon")
        if (isHeaderLine(line) && isTypeLine(line)) {
            potentialStart = true;
            isOneLineItem = true;
            typeLineIndex = i;
        } 
        // Case 2: Header + Type on subsequent lines
        else if (isHeaderLine(line)) {
            // Look ahead for Type line
            for (let j = 1; j <= 3; j++) {
                if (i + j < lines.length && isTypeLine(lines[i+j])) {
                    typeLineIndex = i + j;
                    potentialStart = true;
                    break;
                }
            }
        }

        if (potentialStart) {
            // Close previous
            if (currentItem) {
                const descLines = lines.slice(itemStartIndex, i);
                const cleanDesc = descLines.map(l => l.replace(/^###HEADER:[\d.]+###/, '')).filter(l => {
                    if (l === currentItem.name) return false;
                    if (l === currentItem.type) return false;
                    // Filter out garbage in description
                    if (l.includes('Not for resale')) return false;
                    if (l.includes('More resources at')) return false;
                    return true;
                }).join('\n');
                currentItem.description = cleanDesc;
                
                const parts = cleanDesc.split(/\n\s*\n/);
                if (parts.length > 1) {
                    currentItem.flavor = parts[0];
                    currentItem.details = parts.slice(1).join('\n\n');
                } else {
                    currentItem.flavor = cleanDesc;
                    currentItem.details = cleanDesc;
                }
                
                const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s+damage/i);
                if (dmgMatch) {
                    currentItem.damage = { dice: dmgMatch[1], type: dmgMatch[2] };
                }
                
                // Final Check: Name validity
                if (currentItem.name.length < 60 && !currentItem.name.match(/^\d+$/)) {
                    items.push(currentItem);
                }
            }

            // Start New
            let name = cleanL;
            let type = "";
            
            if (isOneLineItem) {
                // Extract Name and Type from the single line using regex
                const match = cleanL.match(rarityRegex);
                if (match) {
                    name = match[1].trim();
                    type = match[2].trim(); 
                    // Use full tail
                    type = cleanL.substring(name.length).trim().replace(/^[\s.-]+/, '');
                } else {
                     // Try reversed regex
                     const revMatch = cleanL.match(reversedRarityRegex);
                     if (revMatch) {
                         // This case is unlikely for OneLineItem (Header+Type on same line)
                         // because reversed regex starts with Rarity.
                         // e.g. "COMMONWondrous item" -> Name would be empty?
                         // If "ItemName COMMONWondrous item", then standard regex might fail.
                         // But usually Artifacts of the Guild has Header on separate line.
                     }
                }
                itemStartIndex = i + 1;
            } else {
                // Multi-line
                const typeLLine = lines[typeLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                
                // Check which regex matched
                const match = typeLLine.match(rarityRegex);
                if (match) {
                     type = typeLLine;
                } else {
                     const revMatch = typeLLine.match(reversedRarityRegex);
                     if (revMatch) {
                         // e.g. COMMONWondrous item
                         // revMatch[1] = COMMON
                         // revMatch[2] = Wondrous item
                         // We want Type to be "Wondrous item, COMMON" or just "Wondrous item"
                         // Let's normalize it to "Type (Rarity)" style
                         type = `${revMatch[2].trim()} (${revMatch[1].trim()})`;
                     } else {
                         type = typeLLine;
                     }
                }
                
                itemStartIndex = typeLineIndex + 1; 
                i = typeLineIndex; // Skip to type line
            }
            
            // Validation on Name start
            // Reject if name contains "Table" or "List"
            // Reject if name ends with '.' (likely a sentence)
            
            // Check for known garbage in Name
            if (name.toUpperCase().includes('TABLE OF CONTENTS')) {
                currentItem = null;
            } else {
                 // Relaxed Case check
                 let finalName = name;
                 if (finalName.length > 0 && finalName[0] !== finalName[0].toUpperCase()) {
                     finalName = finalName.charAt(0).toUpperCase() + finalName.slice(1);
                 }

                 if (finalName.length > 2 && !finalName.endsWith('.')) {
                       // Length Check to avoid description lines being picked up
                       if (finalName.length < 100) {
                           currentItem = {
                             name: finalName,
                             type: type,
                             source: source,
                             description: "",
                             flavor: "",
                             details: "",
                             image: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiI+CiAgPGNpcmNsZSBjeD0iMjU2IiBjeT0iMjU2IiByPSIyNTAiIGZpbGw9IiM0YTIzNWEiIC8+CiAgPHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjUwIiBmaWxsPSJ3aGl0ZSIgZm9udC1mYW1pbHk9IkFyaWFsIj5JPC90ZXh0Pgo8L3N2Zz4="
                          };
                       } else {
                           // console.log(`[DEBUG] Rejected Long Name: ${finalName}`);
                           currentItem = null;
                       }
                  } else {
                      currentItem = null;
                  }
        }
    }
    }
    
    // Close last item
    if (currentItem) {
         const descLines = lines.slice(itemStartIndex);
         const cleanDesc = descLines.map(l => l.replace(/^###HEADER:[\d.]+###/, '')).filter(l => {
            if (l === currentItem.name) return false;
            if (l === currentItem.type) return false;
            if (l.includes('Not for resale')) return false;
            if (l.includes('More resources at')) return false;
            return true;
         }).join('\n');
         currentItem.description = cleanDesc;
         
         const parts = cleanDesc.split(/\n\s*\n/);
         if (parts.length > 1) {
             currentItem.flavor = parts[0];
             currentItem.details = parts.slice(1).join('\n\n');
         } else {
             currentItem.flavor = cleanDesc;
             currentItem.details = cleanDesc;
         }
         
         const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s+damage/i);
         if (dmgMatch) {
             currentItem.damage = { dice: dmgMatch[1], type: dmgMatch[2] };
         }
         
         if (currentItem.name.length < 60 && !currentItem.name.match(/^\d+$/)) {
             items.push(currentItem);
         }
    }
    
    return items;
}

async function main() {
    if (!fs.existsSync(PDF_DIR)) {
        console.error("PDF directory not found:", PDF_DIR);
        return;
    }

    const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
    let allItems = [];

    for (const file of files) {
        console.log(`Processing ${file}...`);
        const dataBuffer = fs.readFileSync(path.join(PDF_DIR, file));
        try {
            const data = await pdf(dataBuffer, { pagerender: render_page });
            const items = extractItems(data.text, file);
            console.log(`  Found ${items.length} items`);
            allItems = allItems.concat(items);
        } catch (e) {
            console.error(`Error parsing ${file}:`, e);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allItems, null, 2));
    console.log(`\nSuccess! Saved ${allItems.length} items to ${OUTPUT_FILE}`);
}

main();
