import fs from 'node:fs/promises';
const dictionary=await fs.readFile('node_modules/dictionary-en/index.dic','utf8');
const words=[...new Set(dictionary.split('\n').map(line=>line.split('/')[0]).filter(word=>/^[a-z]+(?:'[a-z]+)?$/.test(word)))].sort();
await fs.writeFile('src/shared/english-words.json',JSON.stringify(words));
await fs.mkdir('public/licenses',{recursive:true});
await fs.copyFile('node_modules/dictionary-en/license','public/licenses/dictionary-en.txt');
