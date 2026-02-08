import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// Canvas Factory for Node.js
class NodeCanvasFactory {
    create(width, height) {
        const canvas = Canvas.createCanvas(width, height);
        const context = canvas.getContext('2d');
        return { canvas, context };
    }

    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}
const BANNED_IMAGE_ASSIGNMENTS = new Set([
    "YAGA GOO", // Wrong image (Baba Yaga) on its page
    "WASTELAND DRAGON", "WASTELAND DRAGON WYRMLING", "YOUNG WASTELAND DRAGON", "ADULT WASTELAND DRAGON", "ANCIENT WASTELAND DRAGON",
    "ANCIENT LIGHT DRAGON", "ADULT LIGHT DRAGON", "LIGHT DRAGON WYRMLING"
]);

function analyzeImageComplexity(imgData) {
    const data = imgData.data;
    const isRGBA = data.length === imgData.width * imgData.height * 4;
    const stride = isRGBA ? 4 : 3;

    const colorSet = new Set();
    let sumR = 0, sumG = 0, sumB = 0;
    let sumSqR = 0, sumSqG = 0, sumSqB = 0;
    let pixelCount = 0;
    let blackPixelCount = 0;

    for (let i = 0; i < data.length; i += stride * 10) { // Sample every 10th pixel for speed
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const a = isRGBA ? data[i+3] : 255;

        if (a < 50) continue; // Skip transparent

        pixelCount++;
        sumR += r;
        sumG += g;
        sumB += b;
        sumSqR += r*r;
        sumSqG += g*g;
        sumSqB += b*b;

        // Quantize color (32 levels)
        const key = `${Math.floor(r/8)},${Math.floor(g/8)},${Math.floor(b/8)}`;
        colorSet.add(key);

        if (r < 30 && g < 30 && b < 30) blackPixelCount++;
    }

    if (pixelCount === 0) return { uniqueColors: 0, stdDev: 0, blackRatio: 0 };

    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;

    const varR = (sumSqR / pixelCount) - (avgR * avgR);
    const varG = (sumSqG / pixelCount) - (avgG * avgG);
    const varB = (sumSqB / pixelCount) - (avgB * avgB);

    const stdDev = Math.sqrt(varR + varG + varB); // Combined stdDev
    const blackRatio = blackPixelCount / pixelCount;

    return { uniqueColors: colorSet.size, stdDev, blackRatio, avgR, avgG, avgB };
}

function isWhiteSilhouette(imgData, complexity = null) {
    // If complexity not provided, calculate it (or do basic check)
    // We will use the passed complexity if available
    
    // 1. Basic White Silhouette Check (High Brightness, Low Saturation)
    // Re-implemented inside here or use the complexity stats
    
    // We'll run a quick pass if complexity is null, but ideally we use the full scan
    if (!complexity) complexity = analyzeImageComplexity(imgData);

    const { avgR, avgG, avgB, stdDev, blackRatio, uniqueColors } = complexity;
    const avgDiff = Math.abs(avgR - avgG) + Math.abs(avgG - avgB) + Math.abs(avgB - avgR); // Rough chroma

    // CHECK 1: Bright White Silhouette (Masks)
    if (avgR > 210 && avgG > 210 && avgB > 210 && avgDiff < 30) {
        console.log(`      Skipping white silhouette (Avg RGB: ${avgR.toFixed(0)}, ${avgG.toFixed(0)}, ${avgB.toFixed(0)}, Diff: ${avgDiff.toFixed(0)})`);
        return true;
    }

    // CHECK 2: Dark Mask / "White on Black" (Mostly black, low color variance)
    // If > 50% black and low color variety, it's a mask or space filler
    // Also check for "Splatter" style: High contrast but low saturation in non-black pixels
    if (blackRatio > 0.5) {
         // It's a dark image. Check the non-black parts.
         // If non-black parts are white/gray (low avgDiff), it's a splatter mask.
         // Increased strictness: Real art usually has > 100 unique colors even if dark
         if (avgDiff < 25 && uniqueColors < 150) {
             console.log(`      Skipping splatter/mask (Black Ratio: ${blackRatio.toFixed(2)}, Diff: ${avgDiff.toFixed(0)}, Colors: ${uniqueColors})`);
             return true;
         }
         
         // Also catch simple shapes with low variance
         if (stdDev < 20 && uniqueColors < 100) {
             console.log(`      Skipping simple dark shape (StdDev: ${stdDev.toFixed(2)}, Colors: ${uniqueColors})`);
             return true;
         }
    }

    // CHECK 3: Low Complexity (Flat colors, gradients, splatters)
    // Real illustrations have high color count and variance
    if (uniqueColors < 20 || stdDev < 15) {
        console.log(`      Skipping low complexity image (Colors: ${uniqueColors}, StdDev: ${stdDev.toFixed(2)})`);
        return true;
    }

    return false;
}

async function extractImagesFromPDF(pdfPath, monstersInPdf, allMonsters) {
    const pdfName = path.basename(pdfPath, path.extname(pdfPath));
    const pdfImageDir = path.join(IMAGES_DIR, pdfName);
    
    // Ensure PDF specific image directory exists
    if (!fs.existsSync(pdfImageDir)) {
        fs.mkdirSync(pdfImageDir, { recursive: true });
    }

    console.log(`Processing ${path.basename(pdfPath)}...`);
    console.log(`  Target Directory: ${pdfImageDir}`);

    // PDF Specific Filters
    const isCreatureCodex = pdfName.includes('Creature_Codex');
    const isFleeMortals = pdfName.includes('Flee__Mortals');
    
    // Reset images for all monsters in this PDF to ensure fresh assignment
    monstersInPdf.forEach(m => m.image = null);

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        canvasFactory: new NodeCanvasFactory(),
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    console.log(`  Loaded ${doc.numPages} pages.`);
    
    // Determine Start Page
    let startPage = 1;
    if (process.argv[3]) {
        startPage = parseInt(process.argv[3]);
        console.log(`  Starting from Page ${startPage} (Argument provided)`);
    } else if (isFleeMortals) {
        startPage = 35; // Default for Flee Mortals
        console.log(`  Starting from Page ${startPage} (Flee Mortals default)`);
    }

    // Debug: Check if ANKOU is in the list
    const ankouCheck = monstersInPdf.find(m => m.name.includes('ANKOU'));
    console.log(`  DEBUG: Monsters in list: ${monstersInPdf.length}. Has ANKOU? ${ankouCheck ? ankouCheck.name : 'No'}`);

    let matchedCount = 0;
    let lastContextImage = null;
    const globalAssignedMonsters = new Set();

    const endPage = process.argv[4] ? parseInt(process.argv[4]) : doc.numPages;
    for (let i = startPage; i <= endPage; i++) {
                try {
                    const page = await doc.getPage(i);
                    
                    // 1. Get Text to find monsters on this page
                    const textContent = await page.getTextContent();
                    const textItems = textContent.items;

                    if (i === 10) {
                        const agnibarra = monstersInPdf.find(m => m.name.toUpperCase().includes('AGNIBARRA'));
                        console.log(`    DEBUG PAGE 10: Has Agnibarra? ${!!agnibarra}`);
                        if (agnibarra) console.log(`      Name in list: "${agnibarra.name}"`);
                    }
                    
                    // Extract Page Keywords (Large Text -> Likely Headers)
            const pageKeywords = new Set();
            textItems.forEach(item => {
                const height = Math.abs(item.transform[3]);
                const text = item.str.trim();
                
                // Debug text sizes on Page 36
                if (i === 36 && text.length > 0) {
                     console.log(`    Page 36 Text: "${item.str}" Size=${height}`);
                }
                
                let isHeader = false;
                
                // Standard Large Header
                if (height > 14) isHeader = true;
                
                // All Caps Medium Header
                else if (height > 10 && /^[A-Z\s]+$/.test(text) && text.length > 3) isHeader = true;
                
                // Flee Mortals specific: Mixed case headers > 12
                else if (isFleeMortals && height > 12 && text.length > 3) isHeader = true;

                if (isHeader) { 
                        const words = item.str.toUpperCase().split(/\s+/);
                        words.forEach(w => {
                            if (w.length > 3) pageKeywords.add(w.replace(/[^A-Z]/g, ''));
                        });
                    }
            });
            
            const monstersOnPage = [];
            const fullPageText = textItems.map(t => t.str).join(' ');
            
            // Debug Page 38/39 Matching
             if (i === 38) {
                  // Print all items containing ANKOU
                  textItems.forEach(t => {
                      if (t.str.toUpperCase().includes('ANKOU')) {
                          console.log(`    Page 38 Item with ANKOU: "${t.str}" (Y=${t.transform[5]})`);
                      }
                  });
             }
            // if (i >= 26 && i <= 28) { ... }
            
            // Basic check: is the monster name in the text?
            for (const monster of monstersInPdf) {
                if (monster.name.includes('ANKOU') && i === 38) {
                      console.log(`    Checking ANKOU loop: Name=${monster.name}, Image=${monster.image ? monster.image.substring(0, 50) : 'null'}`);
                      // Force process even if it has an image (for debugging)
                      if (monster.image && !monster.image.startsWith('data:')) {
                           console.log(`    Forcing update for ${monster.name}`);
                           monster.image = null; // Clear it to force match
                      }
                }

                // Ignore if we already have a custom image (not the default one)
                if (!monster.image || monster.image.startsWith('data:image/svg+xml') || monster.image.includes('unsplash')) {
                    // Normalize name for search
                    const searchName = monster.name.toUpperCase();
                    if (searchName.startsWith('ANKOU') && i === 38) {
                        console.log(`    Loop check: ${searchName}`);
                    }
                    let foundY = -1;
                    let foundBBoxes = [];

                    // Debug specific matching failure
                    if (searchName === 'ANKOU SOUL HERALD' && i === 38) {
                        console.log(`    DEBUG MATCHING: searching for "${searchName}"`);
                        const exactMatch = textItems.find(t => t.str.toUpperCase().includes(searchName));
                        if (exactMatch) {
                             console.log(`    DEBUG MATCHING: Found exact match in item: "${exactMatch.str}"`);
                        } else {
                             console.log(`    DEBUG MATCHING: No exact match found in items.`);
                             // Print top 3 items that look similar
                             textItems.filter(t => t.str.toUpperCase().includes('ANKOU')).forEach(t => {
                                  console.log(`      Candidate: "${t.str}" (len=${t.str.length}) vs Search (len=${searchName.length})`);
                                  // Check char codes
                                  if (t.str.toUpperCase().includes('ANKOU SOUL HERALD')) {
                                       console.log(`      Wait, it INCLUDES it! Why did find fail?`);
                                  }
                             });
                        }
                    }

                    if (fullPageText.toUpperCase().includes(searchName)) {
                        const nameItems = textItems.filter(t => t.str.toUpperCase().includes(searchName)); 
                        if (nameItems.length > 0) {
                            // Use the first one for Y (default), but store all for overlap check
                            foundY = nameItems[0].transform[5];
                            foundBBoxes = nameItems.map(t => ({
                                x: t.transform[4],
                                y: t.transform[5],
                                w: t.width,
                                h: Math.abs(t.transform[3])
                            }));
                            console.log(`    Found ${nameItems.length} Text Matches for ${searchName}. First Y=${foundY}`);
                        }
                    }

                    if (i === 10 && searchName.includes('AGNIBARRA')) {
                        const squashedPageText = textItems.map(t => t.str).join('').toUpperCase();
                        console.log(`    DEBUG PAGE 10 SQUASHED: "${squashedPageText.substring(0, 200)}..."`);
                    }

                    // 1b. Smart Partial Match (Frequency Analysis)
                    if (foundY === -1) {
                        const parts = searchName.split(' ').filter(p => p.length > 3);
                        if (parts.length > 0) {
                            // Count frequency of each word on the page
                            const wordCounts = parts.map(part => {
                                const regex = new RegExp(part.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'gi');
                                const matches = fullPageText.match(regex);
                                return {
                                    part,
                                    count: matches ? matches.length : 0
                                };
                            });

                            // Sort by frequency (lowest first), then by length (longest first)
                            wordCounts.sort((a, b) => {
                                if (a.count !== b.count) return a.count - b.count;
                                return b.part.length - a.part.length;
                            });

                            // Try to find the rarest word
                            for (const { part, count } of wordCounts) {
                                if (count === 0) continue;
                                
                                console.log(`      Analyzing word "${part}" (Count: ${count})`);
                                
                                // Find the text item for this word
                                // Prefer items that are "Headers" (Large font)
                                const candidates = textItems.filter(t => t.str.toUpperCase().includes(part));
                                
                                let bestCandidate = null;
                                let maxFontSize = 0;

                                candidates.forEach(c => {
                                    const fontSize = Math.abs(c.transform[3]);
                                    if (fontSize > maxFontSize) {
                                        maxFontSize = fontSize;
                                        bestCandidate = c;
                                    }
                                });

                                if (bestCandidate) {
                                    foundY = bestCandidate.transform[5];
                                    foundBBoxes = [{
                                        x: bestCandidate.transform[4],
                                        y: bestCandidate.transform[5],
                                        w: bestCandidate.width,
                                        h: Math.abs(bestCandidate.transform[3])
                                    }];
                                    console.log(`    Smart Match: Found "${part}" at Y=${foundY} (Size=${maxFontSize.toFixed(1)})`);
                                    break;
                                }
                            }
                        }
                    }

                    // 2. Try first word match (Fallback - only if Smart Match failed)
                    if (foundY === -1) {
                         const firstWord = searchName.split(' ')[0];
                         if (firstWord.length > 4 && fullPageText.toUpperCase().includes(firstWord)) {
                             const wordItem = textItems.find(t => t.str.toUpperCase().includes(firstWord));
                             if (wordItem) {
                                 // Verify it's a header (large font)
                                 const h = Math.abs(wordItem.transform[3]);
                                 if (h > 10) {
                                      foundY = wordItem.transform[5];
                                      foundBBoxes = [{
                                          x: wordItem.transform[4],
                                          y: wordItem.transform[5],
                                          w: wordItem.width,
                                          h: h
                                      }];
                                      console.log(`    First Word Match for ${searchName} (Word=${firstWord})`);
                                 }
                             }
                         }
                    }

                    // 3. Keyword Match (Context-based)
                    if (foundY === -1) {
                        // Check if monster name is in pageKeywords (which are large text items)
                        const nameParts = searchName.split(' ');
                        const matchesKeyword = nameParts.some(part => 
                            part.length > 3 && pageKeywords.has(part)
                        );
                        
                        if (matchesKeyword) {
                             console.log(`    Keyword Match for ${searchName} (Found in Page Keywords)`);
                             // Try to find Y from the matching keyword item
                             const part = nameParts.find(p => p.length > 3 && pageKeywords.has(p));
                             const keyItem = textItems.find(t => t.str.toUpperCase().includes(part) && Math.abs(t.transform[3]) > 10);
                             if (keyItem) {
                                 foundY = keyItem.transform[5];
                             } else {
                                 foundY = 0; // Provisional
                             }
                        }
                    }

                    if (foundY !== -1) {
                        monstersOnPage.push({
                            monster,
                            y: foundY,
                            bboxes: foundBBoxes
                        });
                    } else if (searchName.includes('AGNIBARRA') && i === 10) {
                        console.log(`    DEBUG AGNIBARRA FAIL: Squashed="${textItems.map(t => t.str).join('').toUpperCase().substring(0, 100)}..."`);
                    } else if (searchName.includes('ANKOU') && i >= 36 && i <= 40) {
                        // Force add ANKOU if text matching failed, to allow Context Matching to work
                        console.log(`    Forcing ANKOU onto page ${i} for Context Matching`);
                        monstersOnPage.push({
                            monster,
                            y: 100 // Dummy Y
                        });
                    } else {
                        // Keep track of monsters on page even if exact text match fails?
                        // No, if text match fails, we can't place it.
                        // But wait, if we are on the page, maybe we should assume it's there?
                        // For now, rely on text finding.
                        // console.log(`    Monster ${monster.name} not found in text`);
                    }
                }
            }

            if (monstersOnPage.length > 0) {
                 console.log(`  Page ${i}: Found candidates: ${monstersOnPage.map(m => m.monster.name).join(', ')}`);
            } else {
                 console.log(`  Page ${i}: No candidates found (but scanning for context images)`);
            }

            // 2. Extract Images (ALWAYS RUN THIS to update context)
            const ops = await page.getOperatorList();
            const validObjectTypes = [
                pdfjsLib.OPS.paintImageXObject,
                pdfjsLib.OPS.paintXObject,
                pdfjsLib.OPS.paintInlineImageXObject
            ];

            const imagesOnPage = [];
            // Matrix State
            let currentMatrix = [1, 0, 0, 1, 0, 0];
            const transformStack = [];

            for (let j = 0; j < ops.fnArray.length; j++) {
                const fn = ops.fnArray[j];
                const args = ops.argsArray[j];

                if (fn === pdfjsLib.OPS.save) {
                    transformStack.push([...currentMatrix]);
                } else if (fn === pdfjsLib.OPS.restore) {
                    if (transformStack.length > 0) {
                        currentMatrix = transformStack.pop();
                    }
                } else if (fn === pdfjsLib.OPS.transform) {
                    const [a, b, c, d, e, f] = args;
                    const [a1, b1, c1, d1, e1, f1] = currentMatrix;
                    currentMatrix = [
                        a1 * a + c1 * b,
                        b1 * a + d1 * b,
                        a1 * c + c1 * d,
                        b1 * c + d1 * d,
                        a1 * e + c1 * f + e1,
                        b1 * e + d1 * f + f1
                    ];
                }

                if (validObjectTypes.includes(fn)) {
                    const imageName = args[0];
                    console.log(`    Found op ${fn} for: ${imageName} (Y=${currentMatrix[5].toFixed(2)})`);
                    
                    const imageY = currentMatrix[5];
                    const imageX = currentMatrix[4];
                    const imageHeight = Math.hypot(currentMatrix[2], currentMatrix[3]);
                    const imageWidth = Math.hypot(currentMatrix[0], currentMatrix[1]);

                    // Debug: Print ALL image dimensions before filtering
                    if (startPage && i === startPage) {
                        console.log(`    DEBUG IMAGE on Page ${i}: ${imageName} - Display Size: ${imageWidth.toFixed(2)}x${imageHeight.toFixed(2)}`);
                    }

                    // Retrieve image data with timeout
                    try {
                        await new Promise((resolve) => {
                            console.log(`      Requesting ${imageName}...`);
                            let resolved = false;
                        const timer = setTimeout(() => {
                            if (!resolved) {
                                console.log(`      Timeout getting ${imageName}`);
                                resolved = true;
                                resolve();
                            }
                        }, 5000);

                        try {
                            page.objs.get(imageName, (imgData) => {
                                if (resolved) return;
                                clearTimeout(timer);
                                resolved = true;

                                if (imgData) {
                                     // console.log(`      Got data for ${imageName}`);
                                     if (imgData.width && imgData.height) {
                                         console.log(`      Extracted image: ${imageName} (${imgData.width}x${imgData.height})`);
                                         if (imgData.width > 200 && imgData.height > 200) {
                                            // Header/Footer Check (Small height) - Global Check
                                            if ((imageY > 700 || imageY < 50) && imageHeight < 150) {
                                                console.log(`      Skipping header/footer image (Y=${imageY.toFixed(0)}, H=${imageHeight.toFixed(0)})`);
                                                resolve();
                                                return;
                                            }
                                            // Full Page Background Check (Wide and Tall) - Global Check
                                            if (imageWidth > 550 && imageHeight > 700) {
                                                console.log(`      Skipping background image (DisplayW=${imageWidth.toFixed(0)}, H=${imageHeight.toFixed(0)})`);
                                                resolve();
                                                return;
                                            }
                                            // Running Header Bar Check (Wide but Short) - Global Check
                                            if (imageWidth > 600 && imageHeight < 100) {
                                                console.log(`      Skipping running header bar (DisplayW=${imageWidth.toFixed(0)}, H=${imageHeight.toFixed(0)})`);
                                                resolve();
                                                return;
                                            }

                                        // Check for White Silhouette (Masks)
                                        if (isWhiteSilhouette(imgData)) {
                                            resolve();
                                            return;
                                        }

                                        const ratio = imgData.width / imgData.height;
                                        
                                        // Stricter Aspect Ratio for Flee Mortals to avoid borders
                                        const minRatio = isFleeMortals ? 0.4 : 0.2;
                                        const maxRatio = isFleeMortals ? 2.5 : 5.0;

                                             if (ratio > minRatio && ratio < maxRatio) {
                                                 imgData.y = imageY;
                                                 imgData.x = imageX;
                                                 imgData.displayHeight = imageHeight;
                                                 imgData.displayWidth = imageWidth;
                                                 imagesOnPage.push(imgData);
                                             } else {
                                                 console.log(`      Skipping due to aspect ratio ${ratio.toFixed(2)} (Min:${minRatio}, Max:${maxRatio})`);
                                             }
                                         } else {
                                             console.log(`      Skipping small image ${imgData.width}x${imgData.height}`);
                                         }
                                     } else {
                                         console.log(`      Image ${imageName} has no dimensions`);
                                     }
                                } else {
                                    console.log(`      Image ${imageName} is invalid or empty`);
                                }
                                resolve();
                            });
                        } catch (e) {
                            if (!resolved) {
                                console.log(`      Error getting ${imageName}: ${e.message}`);
                                clearTimeout(timer);
                                resolved = true;
                                resolve();
                            }
                        }
                    });
                    console.log(`      Finished processing ${imageName}`);
                    } catch (err) {
                        console.log(`      Critical error processing ${imageName}: ${err.message}`);
                    }
                }
            }

            // 3. Match Images to Monsters (Unique Assignment)
            if (monstersOnPage.length > 0) {
                // Calculate all distances between monsters and images
                const potentialMatches = [];
                monstersOnPage.forEach(m => {
                    if (m.y === 0) {
                         console.log(`    Warning: No Y for ${m.monster.name}`);
                    }
                    imagesOnPage.forEach(img => {
                        const dist = Math.abs(m.y - img.y);

                        // Check for Name Inside Image (BBox overlap)
                        let isNameInside = false;
                        if (m.bboxes && m.bboxes.length > 0 && img.displayWidth && img.displayHeight) {
                            // Check ALL occurrences of the name
                            for (const bbox of m.bboxes) {
                                // Simple AABB check
                                // Image Box
                                const imgLeft = img.x;
                                const imgRight = img.x + img.displayWidth;
                                const imgBottom = img.y; // PDF coords, Y increases up
                                const imgTop = img.y + img.displayHeight;

                                // Text Box
                                const textLeft = bbox.x;
                                const textRight = bbox.x + (bbox.w || 50);
                                const textBottom = bbox.y;
                                const textTop = bbox.y + (bbox.h || 10);

                                // Check overlap
                                if (textRight > imgLeft && textLeft < imgRight &&
                                    textTop > imgBottom && textBottom < imgTop) {
                                    isNameInside = true;
                                    break; // Found one occurrence inside
                                }
                            }
                        }

                        potentialMatches.push({
                            monster: m.monster,
                            image: img,
                            dist: dist,
                            monsterY: m.y,
                            isNameInside
                        });
                    });
                });

                // Sort matches by distance, prioritizing name inside
                potentialMatches.sort((a, b) => {
                    if (a.isNameInside && !b.isNameInside) return -1;
                    if (!a.isNameInside && b.isNameInside) return 1;
                    return a.dist - b.dist;
                });

                const assignedImages = new Set();
                const assignedMonsters = new Set();

                potentialMatches.forEach(match => {
                    if (BANNED_IMAGE_ASSIGNMENTS.has(match.monster.name)) {
                        console.log(`    Skipping banned image assignment for ${match.monster.name}`);
                        return;
                    }
                    if (globalAssignedMonsters.has(match.monster.name)) return; // Monster already has image globally
                    if (assignedMonsters.has(match.monster.name)) return; // Monster already has image on this page
                    if (assignedImages.has(match.image)) return;          // Image already assigned

                    // Assign
                    assignedMonsters.add(match.monster.name);
                    globalAssignedMonsters.add(match.monster.name);
                    assignedImages.add(match.image);
                    
                    console.log(`    Matched ${match.monster.name} (Y=${match.monsterY.toFixed(0)}) to image (Y=${match.image.y.toFixed(0)}, Dist=${match.dist.toFixed(0)}, Inside=${match.isNameInside})`);
                    
                    const targetMonster = match.monster;
                    const bestImg = match.image;
                    
                    const sanitizedName = targetMonster.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                    const fileName = `${sanitizedName}_${Date.now()}.png`;
                    const filePath = path.join(pdfImageDir, fileName);
                    
                    saveImage(bestImg, filePath);
                    
                    targetMonster.image = `http://localhost:5173/images/${pdfName}/${fileName}`;
                    matchedCount++;
                });

                // Handle remaining monsters (Context Matching)
                // Disable Context Matching for Flee Mortals to prevent splatter propagation
                if (!isFleeMortals) {
                    monstersOnPage.forEach(m => {
                         if (!globalAssignedMonsters.has(m.monster.name) && !assignedMonsters.has(m.monster.name) && lastContextImage) {
                             const monsterNameWords = m.monster.name.toUpperCase().split(/\s+/);
                             const hasKeywordMatch = monsterNameWords.some(w => 
                                 w.length > 3 && lastContextImage.keywords.has(w.replace(/[^A-Z]/g, ''))
                             );
                             
                             const isAnkou = m.monster.name.includes('ANKOU');
                             const isClose = Math.abs(i - lastContextImage.page) <= 2;
                             
                             if (hasKeywordMatch || (isAnkou && isClose)) {
                                console.log(`    Context Match Logic: Keyword=${hasKeywordMatch}, Ankou=${isAnkou}, Close=${isClose}`);
                                const bestImg = lastContextImage.image;
                                
                                const targetMonster = m.monster;
    
                                if (BANNED_IMAGE_ASSIGNMENTS.has(targetMonster.name)) return;
                                
                                // Global Check again just in case
                                if (globalAssignedMonsters.has(targetMonster.name)) return;
    
                                 const sanitizedName = targetMonster.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                                 const fileName = `${sanitizedName}_${Date.now()}.png`;
                                 const filePath = path.join(pdfImageDir, fileName);
                                 
                                 saveImage(bestImg, filePath);
                                 targetMonster.image = `http://localhost:5173/images/${pdfName}/${fileName}`;
                                 
                                 globalAssignedMonsters.add(targetMonster.name);
                                 matchedCount++;
                                 console.log(`    Matched ${targetMonster.name} to Context Image from Page ${lastContextImage.page}`);
                             }
                         }
                    });
                }
            }

            // 4. Update Context Image (for future pages)
            if (imagesOnPage.length > 0) {
                 // Pick the largest image on page as potential context
                 const sortedImages = [...imagesOnPage].sort((a,b) => (b.width * b.height) - (a.width * a.height));
                 const bestOnPage = sortedImages[0];
                 
                 // Only update if it's a "substantial" image (heuristic)
                 if (bestOnPage.width > 300 && bestOnPage.height > 300) {
                     lastContextImage = {
                         image: bestOnPage,
                         keywords: pageKeywords,
                         page: i
                     };
                     console.log(`    Updated Context Image from Page ${i} (Keywords: ${Array.from(pageKeywords).join(', ')})`);
                 }
            }
            
            // Periodic Save
            if (matchedCount % 10 === 0 && matchedCount > 0) {
                 fs.writeFileSync(MONSTERS_FILE, JSON.stringify(allMonsters, null, 2));
                 console.log(`    Saved progress: ${matchedCount} monsters matched.`);
            }


        } catch (err) {
            console.error(`  Error processing page ${i}:`, err);
        }
    }
    
    return matchedCount;
}

function saveImage(imgData, outPath) {
    const canvas = Canvas.createCanvas(imgData.width, imgData.height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(imgData.width, imgData.height);
    
    for (let k = 0; k < imgData.data.length; k++) {
        imageData.data[k] = imgData.data[k];
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Handle different data formats
    // imgData.data is usually Uint8ClampedArray
    if (imgData.data.length === imgData.width * imgData.height * 4) {
        imageData.data.set(imgData.data);
    } else if (imgData.data.length === imgData.width * imgData.height * 3) {
        // RGB to RGBA
        for (let j = 0, k = 0; j < imgData.data.length; j += 3, k += 4) {
            imageData.data[k] = imgData.data[j];
            imageData.data[k + 1] = imgData.data[j + 1];
            imageData.data[k + 2] = imgData.data[j + 2];
            imageData.data[k + 3] = 255;
        }
    } else {
        // Fallback or error
        return;
    }
    
    // 3. Background Removal (Flood Fill)
    removeBackground(imageData);
    
    ctx.putImageData(imageData, 0, 0);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buffer);
}

function removeBackground(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;
    
    // Helper to get pixel index
    const getIdx = (x, y) => (y * w + x) * 4;
    
    // 1. Detect Background Color from Corners
    // Sample 4 corners and 4 midpoints of edges
    const samples = [
        [0, 0], [w-1, 0], [0, h-1], [w-1, h-1],
        [Math.floor(w/2), 0], [Math.floor(w/2), h-1],
        [0, Math.floor(h/2)], [w-1, Math.floor(h/2)]
    ];
    
    let bgR = 0, bgG = 0, bgB = 0, count = 0;
    let isWhite = true;
    let isBlack = true;
    
    for (const [x, y] of samples) {
        const i = getIdx(x, y);
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const a = data[i+3];
        
        if (a < 255) continue; // Skip already transparent
        
        // Accumulate
        bgR += r;
        bgG += g;
        bgB += b;
        count++;
        
        if (r < 200 || g < 200 || b < 200) isWhite = false;
        if (r > 50 || g > 50 || b > 50) isBlack = false;
    }
    
    if (count === 0) return; // All transparent?
    
    bgR = Math.round(bgR / count);
    bgG = Math.round(bgG / count);
    bgB = Math.round(bgB / count);
    
    // Heuristic: Must be predominantly white or black
    const tolerance = 40; // Tolerance for matching background color
    
    // Debug output for background detection
    console.log(`      BG Check: AvgRGB=${bgR},${bgG},${bgB} White=${isWhite} Black=${isBlack}`);

    let targetMode = null;
    if (isWhite || (bgR > 220 && bgG > 220 && bgB > 220)) {
        // console.log(`      Detected White Background (Avg: ${bgR},${bgG},${bgB}). Removing...`);
        targetMode = 'white';
    } else if (isBlack || (bgR < 40 && bgG < 40 && bgB < 40)) {
        // console.log(`      Detected Black Background (Avg: ${bgR},${bgG},${bgB}). Removing...`);
        targetMode = 'black';
    } else {
        // Not a solid background we want to remove
        return;
    }
    
    // 2. Flood Fill from Edges
    const queue = [];
    const visited = new Uint8Array(w * h); // 0=unvisited, 1=visited
    
    // Add all matching border pixels to queue
    for (let x = 0; x < w; x++) {
        checkAndAdd(x, 0);
        checkAndAdd(x, h-1);
    }
    for (let y = 1; y < h-1; y++) {
        checkAndAdd(0, y);
        checkAndAdd(w-1, y);
    }
    
    function checkAndAdd(x, y) {
        const idx = y * w + x;
        if (visited[idx]) return;
        
        const i = idx * 4;
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        
        // Distance check
        const dist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (dist < tolerance * 3) { 
             queue.push(idx); // Store just the index (faster)
             visited[idx] = 1;
        }
    }
    
    // BFS
    let removedCount = 0;
    while (queue.length > 0) {
        const idx = queue.shift();
        const x = idx % w;
        const y = Math.floor(idx / w);
        const i = idx * 4;
        
        // Set to Transparent
        data[i+3] = 0;
        removedCount++;
        
        // Check neighbors
        const neighbors = [
            {nx: x+1, ny: y}, {nx: x-1, ny: y},
            {nx: x, ny: y+1}, {nx: x, ny: y-1}
        ];
        
        for (const {nx, ny} of neighbors) {
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                checkAndAdd(nx, ny);
            }
        }
    }
    if (removedCount > 0) {
        console.log(`      Removed ${targetMode} background (${removedCount} pixels)`);
    }
}

async function main() {
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));
    
    // Group by source
    const monstersBySource = {};
    monsters.forEach(m => {
        const sources = m.source ? m.source.split(',').map(s => s.trim()) : [];
        sources.forEach(s => {
            if (!monstersBySource[s]) {
                monstersBySource[s] = [];
            }
            monstersBySource[s].push(m);
        });
    });
    
    const targetPdf = process.argv[2];
    if (targetPdf) {
        console.log(`Filtering for PDF containing: "${targetPdf}"`);
    }

    for (const [sourceFile, pdfMonsters] of Object.entries(monstersBySource)) {
        if (targetPdf && !sourceFile.toLowerCase().includes(targetPdf.toLowerCase())) {
            continue;
        }

        console.log(`Source: ${sourceFile}, Monsters: ${pdfMonsters.length}`);
        const pdfPath = path.join(__dirname, '../pdfs', sourceFile);
        if (fs.existsSync(pdfPath)) {
            await extractImagesFromPDF(pdfPath, pdfMonsters, monsters);
        } else {
            console.warn(`PDF not found: ${sourceFile}`);
        }
    }
    
    fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
    console.log("Done! Updated monsters.json");
}

main().catch(console.error);
