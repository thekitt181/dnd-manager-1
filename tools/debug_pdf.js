const pdf = require('pdf-parse');
console.log('Type of pdf:', typeof pdf);
console.log('Keys:', Object.keys(pdf));
console.log('Is Default function?', typeof pdf.default);
