
import https from 'https';

const url = 'https://www.wobblerocket.com/2025/07/20/acid-ants-worldbuilding-with-the-creature-codex/';

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    // Look for img src tags
    const imgMatches = data.match(/<img[^>]+src="([^">]+)"/g);
    if (imgMatches) {
        imgMatches.forEach(match => console.log(match));
    }
    
    // Also look for raw URLs just in case
    const rawMatches = data.match(/https:\/\/[^"]+\.(jpg|png|jpeg)/gi);
    if (rawMatches) {
      console.log('--- RAW MATCHES ---');
      console.log(rawMatches.slice(0, 10).join('\n'));
    }
  });
}).on('error', (err) => {
  console.error(err);
});
