const fs = require('fs');
const path = require('path');
let pdf = require('pdf-parse');

// Fix for some environments where pdf-parse is exported differently
if (typeof pdf !== 'function' && pdf.default) {
    pdf = pdf.default;
}

const PDF_DIR = path.join(__dirname, '../pdfs');
const OUTPUT_FILE = path.join(__dirname, '../src/monsters.json');

// Heuristic patterns for 5e Stat Blocks
const PATTERNS = {
    // Try to find the name (often capitalized words before size/type)
    // This is hard to regex perfectly, so we'll look for the structure:
    // [Name]
    // [Size] [Type], [Alignment]
    // Armor Class [AC]
    // Hit Points [HP]
    startBlock: /^(.*)\n(Tiny|Small|Medium|Large|Huge|Gargantuan)\s+(.*),\s+(.*)$/m,
    
    // Core Stats
    ac: /Armor Class\s+(\d+)/i,
    hp: /Hit Points\s+(\d+)\s*\((.*?)\)/i,
    speed: /Speed\s+(.*)/i,
    
    // Ability Scores (STR DEX CON INT WIS CHA followed by numbers)
    abilities: /STR\s+(\d+)\s*\([+-]\d+\)\s*DEX\s+(\d+)\s*\([+-]\d+\)\s*CON\s+(\d+)\s*\([+-]\d+\)\s*INT\s+(\d+)\s*\([+-]\d+\)\s*WIS\s+(\d+)\s*\([+-]\d+\)\s*CHA\s+(\d+)\s*\([+-]\d+\)/i,
    
    // Sections
    actions: /ACTIONS\s/i,
    legendary: /LEGENDARY ACTIONS\s/i,
};

const RENDER_OPTIONS = {
    normalizeWhitespace: true,
    disableCombineTextItems: false
};

const render_page = async (pageData) => {
    const textContent = await pageData.getTextContent(RENDER_OPTIONS);
    let text = '';
    let lastY;
    let currentLine = '';
    let maxFontSize = 0;

    for (const item of textContent.items) {
        const tx = item.transform;
        const y = tx[5]; // y-coordinate
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
        
        // Check if same line (within tolerance)
        // Note: PDF y-coordinates usually go up or down. 
        if (lastY === undefined || Math.abs(y - lastY) < 2.0) {
            currentLine += item.str; // Join parts of the line
            if (fontSize > maxFontSize) maxFontSize = fontSize;
        } else {
            // New line detected, flush previous
            if (currentLine.trim().length > 0) {
                if (maxFontSize > 10.5) {
                    text += `\n###HEADER:${maxFontSize.toFixed(2)}###${currentLine}`;
                } else {
                    text += `\n${currentLine}`;
                }
            }
            
            // Start new line
            currentLine = item.str;
            maxFontSize = fontSize;
        }
        lastY = y;
    }
    
    // Flush last line
    if (currentLine.trim().length > 0) {
        if (maxFontSize > 10.5) {
            text += `\n###HEADER:${maxFontSize.toFixed(2)}###${currentLine}`;
        } else {
            text += `\n${currentLine}`;
        }
    }
    
    return text;
}

async function processPdf(filePath) {
    console.log(`Processing ${path.basename(filePath)}...`);
    const dataBuffer = fs.readFileSync(filePath);
    
    try {
        const data = await pdf(dataBuffer, { pagerender: render_page });
        const text = data.text;
        return extractMonsters(text, path.basename(filePath));
    } catch (e) {
        console.error(`Error parsing ${filePath}:`, e);
        return [];
    }
}

function extractMonsters(text, source) {
    const monsters = [];
    // Split by newlines, trim, and remove empty lines to normalize structure
    let lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    
    // Pre-process to fix known layout issues (e.g. column reordering)
    lines = preprocessLines(lines, source);

    let currentMonster = null;
    let monsterStartIndex = -1;

    // Helper to identify a Type line (e.g., "Medium humanoid (goblinoid), neutral evil")
    const isTypeLine = (line) => {
        // Strip marker if present for checking
        const clean = line.replace(/^###HEADER:[\d.]+###/, '');
        const sizes = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
        
        // Strict Type Line Check:
        // 1. Must start with a size followed by a space (e.g. "Small " or "Small beast")
        // 2. Must contain a comma (separator for alignment)
        // 3. Must NOT start with "if " or contain "damage" (to avoid false positives from text)
        // 4. Ideally contains alignment keywords
        
        const lower = clean.toLowerCase();
        
        // Check 1: Start with Size + Space
        const startsWithSize = sizes.some(s => lower.startsWith(s.toLowerCase() + ' '));
        if (!startsWithSize) return false;
        
        // Check 2: Comma
        if (!clean.includes(',')) return false;
        
        // Check 3: Anti-patterns
        if (lower.startsWith('if ')) return false;
        if (lower.includes('damage')) return false;
        if (lower.includes('hit:')) return false;
        if (lower.includes('target')) return false; // "Medium or smaller target"
        if (lower.startsWith('medium or smaller')) return false; // Specific text pattern
        
        return true;
    };

    const isValidName = (line) => {
        const clean = line.replace(/^###HEADER:[\d.]+###/, '').trim();
        
        // Ignore running headers/footers commonly found in these PDFs
        if (clean.toUpperCase().includes('CREATURE CODEX')) return false;
        if (clean.toUpperCase().includes('TOME OF BEASTS')) return false;
        if (clean.toUpperCase().includes('FLEE MORTALS')) return false;
        if (clean.toUpperCase().includes('MONSTER MANUAL')) return false;
        if (clean.toUpperCase().startsWith('CHAPTER')) return false;
        if (/^\d+$/.test(clean)) return false; // Just page numbers
        
        // NEW FILTERS for Garbage Entries
        // Reject very short headers that are likely noise
        if (clean.length < 3) return false;
        
        // Allow 3-letter names if they are purely alphabetical (e.g. "Ape", "Imp", "Rat", "Gug")
        // Reject "L 2", "1 A", "A B"
        if (clean.length === 3 && !/^[A-Za-z]+$/.test(clean)) return false;

        // Reject headers starting with digits (e.g. "7 VIDIE'ATN I") unless it's like "10-Headed"
        if (/^\d+\s+[A-Z]/.test(clean)) return false; 
        
        // Reject headers that look like single letters spaced out (e.g. "A - N S")
        if (/^[A-Z]\s+[A-Z]/.test(clean)) return false;

        // Strict rejection of mostly digit/symbol names often found in headers
        if (/^[\w\s]{1,3}\d+$/.test(clean)) return false; // Reject "L 2", "M 7", "N 1"
        
        // Reject common false positives (Action descriptions, XP lines)
        if (clean.includes('piercing damage')) return false;
        if (clean.includes('bludgeoning damage')) return false;
        if (clean.includes('slashing damage')) return false;
        if (clean.includes('psychic damage')) return false;
        if (clean.includes('necrotic damage')) return false;
        if (clean.includes('force damage')) return false;
        if (clean.includes('poison damage')) return false;
        if (clean.includes('acid damage')) return false;
        if (clean.includes('fire damage')) return false;
        if (clean.includes('cold damage')) return false;
        if (clean.includes('lightning damage')) return false;
        if (clean.includes('thunder damage')) return false;
        if (clean.includes(' XP')) return false; // "5 1800 XP"
        if (/^Hit\s+\d+/.test(clean)) return false; // "Hit 17 3d8..."
        if (/^range\s+\d+/.test(clean)) return false;
        if (clean.startsWith('one target')) return false;
        if (clean.startsWith('target ')) return false;
        if (clean.startsWith('creature ')) return false;
        if (clean.toLowerCase().includes('challenge rating')) return false;

        // More aggressive filtering for "Hit" lines that might have extra spaces or symbols
        if (/Hit\s+\d+/.test(clean)) return false;
        if (clean.includes('Hit:')) return false;
        if (clean.includes('target is a')) return false;
        if (clean.includes('target is Medium')) return false;
        if (clean.includes('target is Large')) return false;
        if (clean.includes('target is Huge')) return false;
        if (clean.includes('target is Small')) return false;
        if (clean.includes('target is grappled')) return false;
        
        // Specific typo fixes seen in debug logs
        if (clean.includes('pie rcing damage')) return false;
        if (clean.includes('bludgeoning d a m age')) return false;
        
        // Reject sentence-like headers (often bolded traits detected as headers)
        if (clean.includes(' can use ')) return false;
        if (clean.includes(' into a ')) return false;
        if (clean.includes(' with a ')) return false;
        if (clean.match(/\bThe\s+[a-z]/)) return false; // "The aatxe"
        if (clean.length > 45) return false; // Strict length cap (Valid max is ~36)

        // Comprehensive Ban List for Description Words
        const BANNED_WORDS = [
            ' their ', ' into ', ' with ', ' from ', ' that ', ' which ', ' as ', ' or ', ' for ',
            ' are ', ' is ', ' was ', ' were ', ' has ', ' have ', ' had ', ' can ', ' will ',
            ' may ', ' must ', ' should ', ' would ', ' could ', ' uses ', ' using ', ' used ',
            ' makes ', ' making ', ' made ', ' takes ', ' taking ', ' took ', ' deals ', ' dealing ',
            ' dealt ', ' hits ', ' hitting ', ' attacks ', ' attacking ', ' attacked ',
            ' speed ', ' feet ', ' pounds ', ' day ', ' turn ', ' round ', ' minute ', ' hour ',
            ' spell ', ' slot ', ' level ', ' save ', ' check ', ' roll ', ' bonus ',
            ' action ', ' reaction ', ' legendary ', ' trait ', ' feature ', ' ability ', ' skill ',
            ' proficiency ', ' advantage ', ' disadvantage ', ' resistance ', ' immunity ', ' condition ',
            ' object ', ' point ', ' area ', ' line ', ' cone ', ' cube ', ' sphere ', ' cylinder ',
            ' radius ', ' diameter ', ' width ', ' height ', ' length ', ' depth ', ' weight ',
            ' size ', ' alignment ', ' challenge ',
            ' a ', ' an ', ' treasure ', ' weapon ', ' melee ', ' ranged ', ' battle ', ' life ', ' master ',
            ' time ', ' only ', ' heat ', ' forge ', ' cost ', ' wielding ', ' contains ', ' and ',
            ' fight ', ' battles ', ' tier '
        ];
        
        const lowerClean = clean.toLowerCase();
        const padded = ' ' + lowerClean + ' ';
        if (BANNED_WORDS.some(w => padded.includes(w))) return false;

        return true;
    };

    const isHeaderLine = (line) => {
        if (!line.startsWith('###HEADER:')) return false;
        return isValidName(line);
    };

    const IGNORED_HEADERS = new Set([
        'ACTIONS', 'REACTIONS', 'LEGENDARY ACTIONS', 'LAIR ACTIONS', 
        'REGIONAL EFFECTS', 'VARIANT', 'CREDITS', 'TABLE OF CONTENTS', 'INDEX',
        'APPENDIX', 'STAT BLOCKS', 'SAVING THROWS', 'SKILLS', 'SENSES', 'LANGUAGES', 'CHALLENGE'
    ]);

    // DEBUG: Dump raw lines for MIMIC and MIND FLAYER to verify structure
    if (source.includes('Creature_Codex')) {
        const dumpLines = [];
        for (const line of lines) {
             if (line.includes('VIDIE') || line.includes('L 2') || line.includes('Y B') || line.includes('M 7')) {
                 dumpLines.push(line);
             }
        }
        if (dumpLines.length > 0) {
            fs.writeFileSync('debug_codex_garbage.txt', dumpLines.join('\n'));
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cleanL = line.replace(/^###HEADER:[\d.]+###/, '').trim();

        // HEURISTIC: New Monster Start
        // Primary Signal: Header Marker (Font Size > 10.5)
        // Validation: Followed by Type line
        
        let potentialStart = false;
        let typeLineIndex = -1;
        
        // Strategy: 
        // 1. If it's a Header, it's a strong candidate.
        // 2. Even if not a Header (maybe missed threshold), check if it looks like a Name followed by Type.
        // But prioritizing Header prevents false positives from body text.
        
        // Look ahead for Type line (allow up to 3 lines gap for noise/headers)
        for (let j = 1; j <= 4; j++) {
            if (i + j < lines.length && isTypeLine(lines[i+j])) {
                // Check intermediate lines - they must be skippable (noise)
                let noiseOnly = true;
                for (let k = 1; k < j; k++) {
                    const inter = lines[i+k];
                    const cleanInter = inter.replace(/^###HEADER:[\d.]+###/, '');
                    // Allow page numbers (digits, potentially surrounded by tildes or spaces), known headers, or empty
                    if (!/^[~\-\s]*\d+[~\-\s]*$/.test(cleanInter.trim()) && 
                        !cleanInter.toUpperCase().includes('MONSTER MANUAL') &&
                        !cleanInter.toUpperCase().includes('CREATURE CODEX') &&
                        !cleanInter.toUpperCase().includes('FLEE MORTALS')) {
                        noiseOnly = false;
                        break;
                    }
                }
                
                if (noiseOnly) {
                    typeLineIndex = i + j;
                    break;
                }
            }
        }

        if (isHeaderLine(line)) {
            // Check if it's an ignored header
            const headerText = cleanL.toUpperCase();
            let isIgnored = false;
            for (const ignored of IGNORED_HEADERS) {
                if (headerText.includes(ignored)) {
                    isIgnored = true;
                    break;
                }
            }
            if (!isIgnored) {
                // Strong Signal: If it's an All-Caps Header, treat as start even if Type line is missed (e.g. Lore Section)
                // This handles "MIND FLAYER" (Lore) ... "MIND FLAYER" (Stats) split.
                if (cleanL === headerText && /[A-Z]/.test(cleanL)) {
                     potentialStart = true;
                } else {
                     // Mixed case header - only start if verified by Type Line
                     potentialStart = true; // Wait, original logic was potentialStart = true for ANY header unless ignored.
                     // But we want to be stricter for Mixed Case to avoid splitting on subheaders like "Hunger of the Mind"
                     // So:
                     if (typeLineIndex === -1) {
                         potentialStart = false; // Revoke start if not all-caps and no type line
                     } else {
                         potentialStart = true;
                     }
                }
            }
        }
        
        if (!potentialStart && typeLineIndex !== -1) {
             // Not a header, but followed by Type Line -> Valid Start
             // MUST check if the line itself is a valid name!
             if (isValidName(line)) {
                 potentialStart = true;
             } else {
                 // console.log(`[DEBUG] Skipped invalid name candidate (despite Type Line): ${cleanL}`);
             }
        }

        if (potentialStart) {
            // Check if we need to close previous monster
            // If typeLineIndex is -1, it means we found a Header but no stats yet (Lore Header).
            // We should still break to prevent merging into previous monster.
            
            // CONFIRMED NEW MONSTER (or Lore Section)
            
            // Close existing
            if (currentMonster) {
                const descriptionLines = lines.slice(monsterStartIndex, i);
                
                // Clean up description
                const cleanDesc = descriptionLines.map(l => l.replace(/^###HEADER:[\d.]+###/, '')).filter(l => {
                    if (l === currentMonster.name) return false;
                    if (l === currentMonster.type) return false;
                    if (l.startsWith('Armor Class') || l.startsWith('AC ')) return false;
                    if (l.startsWith('Hit Points') || l.startsWith('HP ')) return false;
                    if (/^[~\-\s]*\d+[~\-\s]*$/.test(l.trim())) return false; 
                    if (l.toUpperCase().includes('CREATURE CODEX')) return false;
                    if (l.toUpperCase().includes('TOME OF BEASTS')) return false;
                    if (l.toUpperCase().includes('FLEE MORTALS')) return false;
                    if (l.toUpperCase().includes('MONSTER MANUAL')) return false;
                    if (l.toUpperCase().startsWith('CHAPTER')) return false;
                    return true;
                }).join('\n');
                
                currentMonster.description = cleanDesc;
                const crMatch = cleanDesc.match(/Challenge\s+([\d/]+)/i);
                currentMonster.cr = crMatch ? crMatch[1] : "Unknown";
                monsters.push(currentMonster);
            }
            
            // Start New
            const nameLine = cleanL;
            let typeLine = "Unknown Type"; 
            let acVal = 10;
            let hpVal = 10;
            
            if (typeLineIndex !== -1) {
                typeLine = lines[typeLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                
                const acLineIndex = lines.findIndex((l, idx) => idx > typeLineIndex && idx < typeLineIndex + 8 && /^(?:###HEADER:[\d.]+###)?(Armor Class|AC)\s+\d+/.test(l));
                if (acLineIndex !== -1) {
                    const acLine = lines[acLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                    const acMatch = acLine.match(/^(?:Armor Class|AC)\s+(\d+)/);
                    if (acMatch) acVal = parseInt(acMatch[1]);
                    
                     // HP
                    const hpLineIndex = lines.findIndex((l, idx) => idx > acLineIndex && idx < acLineIndex + 5 && /^(?:###HEADER:[\d.]+###)?(Hit Points|HP)\s+\d+/.test(l));
                    if (hpLineIndex !== -1) {
                         const hpLine = lines[hpLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                         const hpMatch = hpLine.match(/^(?:Hit Points|HP)\s+(\d+)/);
                         if (hpMatch) hpVal = parseInt(hpMatch[1]);
                    }
                    
                    // Advance index to skip stats
                    i = acLineIndex; 
                } else {
                    // Type found but AC not found nearby.
                    // Just start at Name.
                }
            }

            currentMonster = {
                name: nameLine,
                type: typeLine,
                source: source,
                hp: hpVal,
                ac: acVal,
                stats: {},
                description: "",
                image: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiI+CiAgPGRlZnM+CiAgICA8cmFkaWFsR3JhZGllbnQgaWQ9ImdyYWQxIiBjeD0iNTAlIiBjeT0iNTAlIiByPSI1MCUiIGZ4PSI1MCUiIGZ5PSI1MCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdHlsZT0ic3RvcC1jb2xvcjojZmY2YjZiO3N0b3Atb3BhY2l0eToxIiAvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0eWxlPSJzdG9wLWNvbG9yOiM4YjAwMDA7c3RvcC1vcGFjaXR5OjEiIC8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgogIDwvZGVmcz4KICA8Y2lyY2xlIGN4PSIyNTYiIGN5PSIyNTYiIHI9IjI1MCIgZmlsbD0idXJsKCNncmFkMSkiIC8+CiAgPHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjUwIiBmaWxsPSJ3aGl0ZSIgZm9udC1mYW1pbHk9IkFyaWFsIj5NPC90ZXh0Pgo8L3N2Zz4="
            };
            
            if (nameLine.includes('MIND FLAYER')) {
                console.log(`[DEBUG] Started MIND FLAYER. Type: ${typeLine}, AC: ${acVal}`);
            }

            monsterStartIndex = i;
            continue;
        }

        // Late Bind Stats Logic
        // If current monster has no stats (likely started from a Header-only break),
        // try to find stats in the body.
        if (currentMonster && (currentMonster.ac === 10 || currentMonster.type === "Unknown Type")) {
             
              if (currentMonster.name.includes('MIND FLAYER') && (isTypeLine(line) || cleanL.includes('Medium aberration'))) {
                  console.log(`[DEBUG] Late Bind Check for MIND FLAYER. Line: ${cleanL}`);
                  console.log(`[DEBUG] isTypeLine: ${isTypeLine(line)}`);
              }

              // Check if current line is Type Line
              if (isTypeLine(line)) {
                  // Check for AC nearby
                  const acLineIndex = lines.findIndex((l, idx) => idx > i && idx < i + 8 && /^(?:###HEADER:[\d.]+###)?(Armor Class|AC)\s+\d+/.test(l));
                  
                  if (acLineIndex !== -1) {
                      console.log(`Late binding stats for ${currentMonster.name}`);
                      const typeLine = cleanL;
                      const acLine = lines[acLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                      const acMatch = acLine.match(/^(?:Armor Class|AC)\s+(\d+)/);
                      if (acMatch) currentMonster.ac = parseInt(acMatch[1]);
                      
                      currentMonster.type = typeLine;
                      
                      // HP
                      const hpLineIndex = lines.findIndex((l, idx) => idx > acLineIndex && idx < acLineIndex + 5 && /^(?:###HEADER:[\d.]+###)?(Hit Points|HP)\s+\d+/.test(l));
                      if (hpLineIndex !== -1) {
                          const hpLine = lines[hpLineIndex].replace(/^###HEADER:[\d.]+###/, '');
                          const hpMatch = hpLine.match(/^(?:Hit Points|HP)\s+(\d+)/);
                          if (hpMatch) currentMonster.hp = parseInt(hpMatch[1]);
                      }
                      
                      // Advance index to skip stats lines so they don't appear in description
                      i = acLineIndex;
                      continue;
                  }
             }
        }
    }
    
    // Close the last monster
    if (currentMonster) {
        const descriptionLines = lines.slice(monsterStartIndex);
         const cleanDesc = descriptionLines.map(l => l.replace(/^###HEADER:[\d.]+###/, '')).filter(l => {
            if (l === currentMonster.name) return false;
            if (l === currentMonster.type) return false;
            if (l.startsWith('Armor Class') || l.startsWith('AC ')) return false;
            if (l.startsWith('Hit Points') || l.startsWith('HP ')) return false;
             if (/^\d+$/.test(l)) return false; 
            if (l.toUpperCase().includes('CREATURE CODEX')) return false;
            if (l.toUpperCase().includes('TOME OF BEASTS')) return false;
            return true;
        }).join('\n');
        currentMonster.description = cleanDesc;
         const crMatch = cleanDesc.match(/Challenge\s+([\d/]+)/i);
        currentMonster.cr = crMatch ? crMatch[1] : "Unknown";
        monsters.push(currentMonster);
    }
    
    // Final Filter: Remove incomplete monsters (Lore-only entries that never matched a stat block)
    // Real monsters must have found at least some stats or a valid Type line.
    // We allow AC 10 / HP 10 only if Type is known.
    // If Type is "Unknown Type" AND stats are default, it's garbage (Header noise).
    return monsters.filter(m => {
        const isDefaultStats = m.ac === 10 && m.hp === 10;
        const isUnknownType = m.type === "Unknown Type";
        
        if (isUnknownType && isDefaultStats) {
            // console.log(`Dropped incomplete entry: ${m.name}`);
            return false;
        }
        return true;
    });
}

function preprocessLines(lines, source) {
    if (source === 'Creature_Codex.pdf') {
        // Fix for KINNARA: Traits appear before Name/Stats due to column layout
        // Look for the misplaced block starting with "Eternal Lovers" and ending before "KINNARA"
        // Note: Lines may have ###HEADER...### prefix
        
        const kinnaraIndex = lines.findIndex(l => l.includes('KINNARA'));
        const eternalLoversIndex = lines.findIndex(l => l.includes('Eternal Lovers. The kinnara'));
        
        if (kinnaraIndex !== -1 && eternalLoversIndex !== -1 && eternalLoversIndex < kinnaraIndex) {
            console.log('Applying KINNARA layout fix...');
            const blockEndIndex = kinnaraIndex; 
            const block = lines.slice(eternalLoversIndex, blockEndIndex);
            lines.splice(eternalLoversIndex, blockEndIndex - eternalLoversIndex);
            
            const newKinnaraIndex = lines.findIndex(l => l.includes('KINNARA'));
            const challengeIndex = lines.findIndex((l, idx) => idx > newKinnaraIndex && idx < newKinnaraIndex + 20 && l.includes('Challenge '));
            
            if (challengeIndex !== -1) {
                lines.splice(challengeIndex + 1, 0, ...block);
                console.log('Moved KINNARA traits block to correct position.');
            }
        }
    }
    return lines;
}

async function main() {
    if (!fs.existsSync(PDF_DIR)) {
        console.error("PDF directory not found:", PDF_DIR);
        return;
    }

    const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
    let allMonsters = [];

    for (const file of files) {
        const monsters = await processPdf(path.join(PDF_DIR, file));
        console.log(`  Found ${monsters.length} monsters in ${file}`);
        allMonsters = allMonsters.concat(monsters);
    }

    // De-duplicate by name and merge entries
    const monsterMap = new Map();
    
    for (const m of allMonsters) {
        // Clean name (remove trailing numbers or weird chars)
        const cleanName = m.name.replace(/[^\w\s'-]/g, '').trim();
        if (cleanName.length < 3) continue; // Noise
        
        m.name = cleanName; // Normalize name in object
        
        if (monsterMap.has(cleanName)) {
             const existing = monsterMap.get(cleanName);
             
             // Merge Strategy:
             // 1. Stats: Prefer existing if valid, else take new. 
             //    If existing has default/weak stats and new has better, take new.
             //    Default stats are usually AC 10, HP 10 (from initialization).
             
             const existingHasStats = existing.ac !== 10 || existing.hp !== 10;
             const newHasStats = m.ac !== 10 || m.hp !== 10;
             
             if (!existingHasStats && newHasStats) {
                 // Upgrade stats
                 existing.ac = m.ac;
                 existing.hp = m.hp;
                 existing.type = m.type; // Assuming Type accompanies stats
                 existing.cr = m.cr !== "Unknown" ? m.cr : existing.cr;
             }
             
             // 2. Description: Append if not duplicate content
             //    (Avoid duplicating the exact same description if processed twice)
             //    Check if the new description is already contained or substantially similar
             if (m.description && !existing.description.includes(m.description.substring(0, 50))) {
                 existing.description += "\n\n" + m.description;
             }
             
             // 3. Source: Append if different
             if (!existing.source.includes(m.source)) {
                 existing.source += ", " + m.source;
             }
             
        } else {
            monsterMap.set(cleanName, m);
        }
    }
    
    const uniqueMonsters = Array.from(monsterMap.values());

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(uniqueMonsters, null, 2));
    console.log(`\nDone! Extracted ${uniqueMonsters.length} unique monsters to ${OUTPUT_FILE}`);
}

// Only run if called directly
if (require.main === module) {
    main();
}

module.exports = { processPdf };